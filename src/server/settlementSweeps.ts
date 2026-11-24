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
import { EVIDENCE_RETENTION_SEC, cancelSession, closeSessionForRent, finalizeAndApply } from "./settlement.js";
import { readSession } from "./routerChain.js";
import { releaseStake } from "./stakeTx.js";

const nowSec = () => Math.floor(Date.now() / 1000);

export const RESUMABLE_STATES = new Set(["dispute_wait", "under_review", "finalizing", "applying"]);

/** States where an on-chain session may exist but play never settled. */
export const VOIDABLE_STATES = new Set(["creating", "reserving", "active", "complete"]);

const REVIEW_POLL_MS = 5 * 60_000;

async function releaseRowStakes(row: SessionRow): Promise<void> {
  if (!row.pda) return;
  const sides = [
    { wallet: row.player_a_wallet, streamId: row.player_a_stream },
    ...(row.player_b_wallet && row.player_b_stream
      ? [{ wallet: row.player_b_wallet, streamId: row.player_b_stream }]
      : []),
  ];
  for (const s of sides) {
    try {
      await releaseStake({ sessionPda: row.pda, holder: s.wallet, streamId: s.streamId });
    } catch (err) {
      logger.error(
        { sessionId: row.id, wallet: s.wallet, err: err instanceof Error ? err.message : String(err) },
        "reconciler.release_failed",
      );
    }
  }
}

/**
 * A match that had an on-chain session but never reached settlement (crash
 * during reserving/play): cancel the session, then release any reservation
 * so the players' stakes aren't locked until reserved_until.
 */
export async function voidRow(row: SessionRow): Promise<void> {
  const log = logger.child({ sessionId: row.id, pda: row.pda });
  try {
    if (row.pda) {
      const st = await readSession(row.pda);
      if (st && st.status === "Open") {
        await cancelSession({ sessionId: row.id, pda: row.pda, broadcast: () => {} });
      }
      await releaseRowStakes(row);
    }
    setFailed(row.id, "cancelled", "crash_recovery: voided before settlement");
    log.warn({ prevState: row.state }, "reconciler.voided_pre_settlement");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setFailed(row.id, "failed", `crash_recovery: void failed: ${msg}`);
    log.error({ msg }, "reconciler.void_failed");
  }
}

/** Wait out an arbiter decision for a resumed row. */
async function awaitArbiter(row: SessionRow): Promise<"finalize" | "cancelled"> {
  for (;;) {
    let st;
    try {
      st = await readSession(row.pda!);
    } catch {
      st = undefined;
    }
    if (st === null) return "finalize";
    if (st?.status === "Cancelled") {
      await releaseRowStakes(row);
      setSessionState(row.id, "cancelled");
      return "cancelled";
    }
    if (st && !st.hasDispute) return "finalize";
    if (st?.hasDispute) setSessionState(row.id, "under_review");
    await new Promise((r) => setTimeout(r, REVIEW_POLL_MS));
  }
}

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
      if ((await awaitArbiter(row)) === "cancelled") {
        log.warn("reconciler.resume_dispute_upheld");
        return;
      }
      setSessionState(row.id, "finalizing");
      try {
        const out = await finalizeAndApply({
          sessionId: row.id,
          pda,
          deltas,
          broadcast: () => {}, // no live sockets after a restart
        });
        // apply only touches the loser's stream; free the winner's own reservation.
        await releaseRowStakes(row);
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
