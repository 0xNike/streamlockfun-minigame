/**
 * Lifecycle-aware, bps-aware matchmaker.
 *
 * Replaces the scaffold's "first two streams" pairing with a real check:
 *   - is the stream still wagerable (not settled, not closed)?
 *   - does the holder have ≥ stakeBps to absorb a loss?
 *
 * Returns the two highest-bps eligible streams. Adapt to your matchmaking
 * logic (queue, ELO, region) by replacing the sort or filter.
 */

import { op, GAME_TOKEN_MINT } from "./operator.js";
import type { CanApplyDeltaResult, IsWagerableResult } from "@streamlock/operator-sdk";

export type Player = { holder: string; streamId: string; bps: number };

export type FindPairingResult =
  | { ok: true; p1: Player; p2: Player }
  | { ok: false; reason: "too_few_eligible"; eligibleCount: number; totalStreams: number };

export async function findPairing(stakeBps: number): Promise<FindPairingResult> {
  const { streams } = (await op.tokens.streams(GAME_TOKEN_MINT)) as {
    streams: Array<{ holder: string; streamId: string }>;
  };

  const eligible: Player[] = [];

  // Sequential to keep rate-limit footprint small. With many streams,
  // batch with Promise.all and a small concurrency limit.
  for (const s of streams) {
    const wager: IsWagerableResult = await op.streams.isWagerable(s.streamId);
    if (!wager.ok) continue;

    const check: CanApplyDeltaResult = await op.streams.canApplyDelta(
      s.streamId,
      s.holder,
      -stakeBps,
    );
    if (!check.ok) continue;

    eligible.push({ holder: s.holder, streamId: s.streamId, bps: check.currentBps });
  }

  if (eligible.length < 2) {
    return { ok: false, reason: "too_few_eligible", eligibleCount: eligible.length, totalStreams: streams.length };
  }

  // Largest-bps first; opposing strategies (random, ELO, queue order) replace this line.
  eligible.sort((a, b) => b.bps - a.bps);
  return { ok: true, p1: eligible[0], p2: eligible[1] };
}
