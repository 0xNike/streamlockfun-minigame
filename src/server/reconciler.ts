/**
 * Crash recovery: walk all non-terminal sessions on startup.
 *
 * Phase 1 policy:
 *   - Pre-settlement states (partnered, creating, active, complete): mark failed.
 *     The mini-game has no way to resume mid-play state from disk in v0; the
 *     streams are still free to be re-engaged in a fresh match. No on-chain
 *     footprint to clean up for `partnered`; for `creating`/`active`/`complete`
 *     a session may exist on-chain but we don't try to cancel it — Phase 3
 *     will read the chain and decide.
 *   - Settlement-stage states (submitting, dispute_wait, finalizing, applying,
 *     cancelling): logged for Phase 3 to handle. Do NOT mark failed because
 *     the chain may still need a forward-step.
 */

import { listNonTerminalSessions, setFailed, type SessionRow } from "./db.js";
import { logger } from "./log.js";
import type { MatchState } from "./types.js";

const PRE_SETTLEMENT: ReadonlySet<MatchState> = new Set([
  "partnered",
  "creating",
  "active",
  "complete",
]);

const SETTLEMENT_STAGE: ReadonlySet<MatchState> = new Set([
  "submitting",
  "dispute_wait",
  "finalizing",
  "applying",
  "cancelling",
]);

export function runOnStartup(): void {
  const rows = listNonTerminalSessions();
  if (rows.length === 0) {
    logger.info("reconciler.idle no non-terminal sessions");
    return;
  }
  let preCount = 0;
  let settlementCount = 0;
  for (const row of rows) {
    if (PRE_SETTLEMENT.has(row.state)) {
      setFailed(row.id, "failed", "crash_recovery: pre-settlement abandon");
      preCount += 1;
      logger.warn(
        { sessionId: row.id, prevState: row.state, pda: row.pda },
        "reconciler.failed_pre_settlement",
      );
    } else if (SETTLEMENT_STAGE.has(row.state)) {
      settlementCount += 1;
      logger.warn(
        {
          sessionId: row.id,
          state: row.state,
          pda: row.pda,
          ageSec: Math.floor(Date.now() / 1000) - row.updated_at,
        },
        "reconciler.todo settlement-stage row needs Phase 3 chain reconciliation",
      );
    } else {
      logger.warn(
        { sessionId: row.id, state: row.state },
        "reconciler.unknown_state non-terminal row in unrecognized state",
      );
    }
  }
  logger.info(
    { total: rows.length, marked_failed: preCount, awaiting_phase3: settlementCount },
    "reconciler.done",
  );
}

export type { SessionRow };
