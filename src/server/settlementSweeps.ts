/**
 * Settlement work that outlives a single process.
 *
 * Since the 2026-11 router fix the dispute window is at least
 * max(config, 3600): 24 h on mainnet. An in-process setTimeout that long will
 * not survive a Fly restart or redeploy, so:
 *
 *   - resumeSettlement: on startup, re-schedule finalize + apply for rows that
 *     were already submitted (dispute_wait / finalizing / applying), using the
 *     pda, end_ts, dispute window and deltas persisted at submit time. Every
 *     step is safe to re-run (see settlement.finalizeAndApply).
 *   - sweepRentReclaim: close session + delta-chunk PDAs for `done` matches
 *     once the router's 7-day evidence retention has passed.
 */

import type { DeltaEntry } from "@streamlock/operator-sdk";
import { config } from "./config.js";
import {
  listRentReclaimDue,
  markRentClosed,
  setFailed,
  setSessionState,
  type SessionRow,
} from "./db.js";
import { logger } from "./log.js";
import { EVIDENCE_RETENTION_SEC, closeSessionForRent, finalizeAndApply } from "./settlement.js";

const nowSec = () => Math.floor(Date.now() / 1000);

export const RESUMABLE_STATES = new Set(["dispute_wait", "finalizing", "applying"]);

/** Re-schedule finalize + apply for a submitted row. Returns false if not resumable. */
export function resumeSettlement(row: SessionRow): boolean {
  if (!row.pda || !row.deltas_json || row.end_ts == null) return false;
  let deltas: DeltaEntry[];
  try {
    deltas = JSON.parse(row.deltas_json) as DeltaEntry[];
  } catch {
    return false;
  }
  if (!Array.isArray(deltas) || deltas.length === 0) return false;

  const eligibleAt = row.end_ts + row.dispute_window_sec + config.FINALIZE_BUFFER_SEC;
  const waitMs = Math.max(0, (eligibleAt - nowSec()) * 1000);
  const log = logger.child({ sessionId: row.id, pda: row.pda });
  log.warn({ prevState: row.state, eligibleAt, waitMs }, "reconciler.resume_settlement_scheduled");

  const pda = row.pda;
  setTimeout(() => {
    void (async () => {
      setSessionState(row.id, "finalizing");
      try {
        const out = await finalizeAndApply({
          sessionId: row.id,
          pda,
          deltas,
          broadcast: () => {}, // no live sockets after a restart
        });
        setSessionState(row.id, "done");
        log.info(out, "reconciler.resume_settlement_done");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setFailed(row.id, "failed", `resume_finalize_failed: ${msg}`);
        log.error({ msg }, "reconciler.resume_settlement_failed");
      }
    })();
  }, waitMs);
  return true;
}

let sweeping = false;

export async function sweepRentReclaim(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    // 1 h of slack past retention so chain clock skew can't trip EvidenceRetention.
    const cutoff = nowSec() - EVIDENCE_RETENTION_SEC - 3600;
    const due = listRentReclaimDue(cutoff);
    if (due.length > 0) logger.info({ count: due.length }, "rent_sweep.start");
    for (const row of due) {
      if (await closeSessionForRent(row.id, row.pda!)) markRentClosed(row.id);
    }
  } finally {
    sweeping = false;
  }
}

const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;

export function startRentSweep(): NodeJS.Timeout {
  setTimeout(() => void sweepRentReclaim(), 60_000);
  return setInterval(() => void sweepRentReclaim(), SWEEP_EVERY_MS);
}
