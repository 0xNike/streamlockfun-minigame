/**
 * Single-match orchestrator: discover → create session → play → submit → finalize.
 *
 * Run with: `npm run match`
 *
 * This is the bare bones of an operator backend. A real production game would:
 *   - Run as a long-lived server (HTTP + WSS) instead of a one-shot script
 *   - Use a queue for matchmaking instead of "first two streams"
 *   - Persist session state in your own DB so a crash doesn't orphan PDAs
 *   - Handle ties with op.sessions.cancel() instead of submitting a no-op
 *   - Subscribe to op.stream.on("stream.unlocked", ...) to proactively settle
 *
 * What this file proves: the SDK is sufficient on its own. Zero internal
 * Streamlock imports — only `@streamlock/operator-sdk` + `@solana/web3.js`.
 */

import type { DeltaEntry } from "@streamlock/operator-sdk";
import { op, GAME_TOKEN_MINT, OPERATOR_PUBKEY } from "./operator.js";
import { playBestOfThree } from "./game.js";

const STAKE_BPS = 1000;            // 10% of a stream's ledger per loss
const DISPUTE_WINDOW_SEC = 60;     // 60s for casual games; longer for high-stakes

type Player = { holder: string; streamId: string };

async function findMatch(): Promise<[Player, Player] | null> {
  const { streams } = await op.tokens.streams(GAME_TOKEN_MINT);
  const eligible = streams.filter((s: any) => !s.settled && !s.closed);
  if (eligible.length < 2) {
    console.log(`[match] only ${eligible.length} eligible stream(s) on ${GAME_TOKEN_MINT.slice(0, 8)}…`);
    return null;
  }
  return [
    { holder: eligible[0].holder, streamId: eligible[0].streamId },
    { holder: eligible[1].holder, streamId: eligible[1].streamId },
  ];
}

async function startSession(p1: Player, p2: Player) {
  console.log("[match] creating session…");
  const session = await op.sessions.create({
    tokenMint: GAME_TOKEN_MINT,
    participants: [
      { wallet: p1.holder, streamId: p1.streamId },
      { wallet: p2.holder, streamId: p2.streamId },
    ],
    endTs: Math.floor(Date.now() / 1000) + 600,
    disputeWindowSec: DISPUTE_WINDOW_SEC,
  });
  console.log(`[match]   pda=${session.result.gameSessionPda}`);
  console.log(`[match]   sig=${session.signature}`);
  return session.result.gameSessionPda;
}

async function settleMatch(sessionPda: string, p1: Player, p2: Player) {
  const result = playBestOfThree();
  console.log(`[match] off-chain: ${result.rounds.length}-round match → winner=${result.winner}`);
  console.log("[match]  ", result.rounds.map((r) => `${r.p1[0]}v${r.p2[0]}=${r.result}`).join("  "));

  if (result.winner === "tie") {
    console.log("[match] tie → cancelling session (no entitlement mutation, rent refunded)");
    await op.sessions.cancel(sessionPda);
    return;
  }

  const [loser, victor] = result.winner === "p1" ? [p2, p1] : [p1, p2];

  // Bps move WITHIN the loser's stream. Sum across deltas == 0.
  const deltas: DeltaEntry[] = [
    { player: loser.holder,  streamId: loser.streamId, deltaBps: -STAKE_BPS },
    { player: victor.holder, streamId: loser.streamId, deltaBps: +STAKE_BPS },
  ];

  console.log(`[match] submitting deltas (loser ${loser.holder.slice(0, 8)}… -${STAKE_BPS}, winner ${victor.holder.slice(0, 8)}… +${STAKE_BPS})`);
  await op.sessions.submit(sessionPda, { startChunkIndex: 0, deltas });

  console.log(`[match] waiting ${DISPUTE_WINDOW_SEC}s dispute window…`);
  await new Promise((r) => setTimeout(r, (DISPUTE_WINDOW_SEC + 5) * 1000));

  console.log("[match] finalizing + applying deltas…");
  const out = await op.sessions.finalizeAndApplyAll(sessionPda, [{ chunkIndex: 0, deltas }]);
  console.log(`[match]   finalize sigs: ${out.finalize.join(",")}`);
  console.log(`[match]   apply sigs:    ${out.apply.join(",")}`);
}

async function main() {
  console.log(`[match] operator: ${OPERATOR_PUBKEY}`);
  console.log(`[match] sdk config: ${JSON.stringify(op.describe())}`);

  const match = await findMatch();
  if (!match) {
    console.log("[match] no players — exiting");
    process.exit(1);
  }

  const [p1, p2] = match;
  console.log(`[match] paired ${p1.holder.slice(0, 8)}… vs ${p2.holder.slice(0, 8)}…`);

  const sessionPda = await startSession(p1, p2);
  await settleMatch(sessionPda, p1, p2);
  console.log("[match] ✅ done");
}

main().catch((err) => {
  console.error("[match] ❌", err);
  process.exit(1);
});
