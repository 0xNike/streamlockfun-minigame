/**
 * One-off recovery for a session whose SubmitResults landed on-chain but whose
 * operator marked it `failed` before finalize/apply ran (e.g. confirmation lost
 * to "block height exceeded", then the retry hit "already in use").
 *
 * The submit is already on-chain; this re-runs the *next* steps —
 * finalizeAndApply — using the pda + deltas persisted at submit time, then
 * marks the session `done`. Safe to re-run: finalizeAndApplyAll is idempotent
 * against an already-finalized session.
 *
 * Usage (on the operator host, where secrets + DB live):
 *   node dist/recover.js <sessionId>            # dry run: print session + deltas
 *   node dist/recover.js <sessionId> --apply    # execute finalize + apply
 */

import type { DeltaEntry } from "@streamlock/operator-sdk";
import { getSession, setSessionState, signaturesForSession } from "./server/db.js";
import { finalizeAndApply } from "./server/settlement.js";

async function main(): Promise<void> {
  const sessionId = process.argv[2];
  const apply = process.argv[3] === "--apply";
  if (!sessionId) {
    console.error("usage: node dist/recover.js <sessionId> [--apply]");
    process.exit(1);
  }

  const row = getSession(sessionId);
  if (!row) {
    console.error(`no session with id ${sessionId}`);
    process.exit(1);
  }

  console.log("session:", sessionId);
  console.log("  state :", row.state);
  console.log("  pda   :", row.pda);
  console.log("  winner:", row.winner);
  console.log("  deltas:", row.deltas_json);
  console.log("  existing sigs:", JSON.stringify(signaturesForSession(sessionId)));

  if (!row.pda) {
    console.error("session has no pda — submit never reached chain; nothing to finalize");
    process.exit(1);
  }
  if (!row.deltas_json) {
    console.error("session has no persisted deltas — cannot finalize");
    process.exit(1);
  }
  const deltas = JSON.parse(row.deltas_json) as DeltaEntry[];

  if (!apply) {
    console.log("\nDRY RUN — re-run with --apply to execute finalizeAndApply.");
    process.exit(0);
  }

  console.log("\nrunning finalizeAndApply…");
  const { finalizeSigs, applySigs } = await finalizeAndApply({
    sessionId,
    pda: row.pda,
    deltas,
    broadcast: () => {},
  });
  console.log("  finalizeSigs:", finalizeSigs);
  console.log("  applySigs   :", applySigs);

  setSessionState(sessionId, "done");
  console.log("session marked done.");
}

main().catch((err) => {
  console.error("recover failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
