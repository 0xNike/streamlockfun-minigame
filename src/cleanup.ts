/**
 * Cancel an orphaned session by PDA.
 *
 * Usage:
 *   npx tsx src/cleanup.ts <sessionPda> [<sessionPda> ...]
 *
 * Use when an earlier `npm run match` exited mid-lifecycle and left a session
 * with rent parked on chain. `cancel_session` refunds the PDA rent and frees
 * the participants for new matches.
 *
 * Caveat: cancel may only be allowed during the on-chain dispute window. If
 * the window has already closed, the cancel call fails — the only path
 * forward is `finalize` (with whatever deltas were submitted) or accepting
 * the session as permanently parked.
 */

import { op } from "./operator.js";
import { OperatorApiError } from "@streamlock/operator-sdk";

async function cleanup(sessionPda: string): Promise<void> {
  console.log(`[cleanup] ${sessionPda}`);

  // Best-effort: read current state so we can give a useful diagnostic.
  let state: any = null;
  try {
    state = await op.sessions.get(sessionPda);
    console.log(`[cleanup]   state: ${JSON.stringify(state).slice(0, 160)}…`);
  } catch (err) {
    if (err instanceof OperatorApiError && err.code === "session_not_found") {
      console.log(`[cleanup]   ✅ already gone (404 session_not_found) — nothing to clean`);
      return;
    }
    console.log(`[cleanup]   warn: get() failed: ${err instanceof Error ? err.message : err}`);
  }

  try {
    const result = await op.sessions.cancel(sessionPda);
    console.log(`[cleanup]   ✅ cancelled — sig=${result.signature}`);
  } catch (err) {
    if (err instanceof OperatorApiError) {
      console.log(`[cleanup]   ❌ cancel failed: ${err.code} — ${err.message}`);
      console.log(`[cleanup]      requestId=${err.requestId}`);
      if (err.code === "dispute_window_closed" || err.message.toLowerCase().includes("window")) {
        console.log(`[cleanup]      → dispute window has closed; cancel is no longer allowed.`);
        console.log(`[cleanup]      → either finalize (op.sessions.finalize + applyDelta) with the original deltas,`);
        console.log(`[cleanup]        or accept this session as permanently parked.`);
      }
    } else {
      console.log(`[cleanup]   ❌ unexpected error: ${err instanceof Error ? err.message : err}`);
    }
  }
}

async function main() {
  const pdas = process.argv.slice(2);
  if (pdas.length === 0) {
    console.error("Usage: npx tsx src/cleanup.ts <sessionPda> [<sessionPda> ...]");
    process.exit(2);
  }

  for (const pda of pdas) {
    await cleanup(pda);
  }
}

main().catch((err) => {
  console.error("[cleanup] fatal:", err);
  process.exit(1);
});
