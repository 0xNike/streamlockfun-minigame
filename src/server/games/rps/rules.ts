/**
 * Deterministic Rock-Paper-Scissors judge for the operator.
 *
 * - judgeRound:    both moves present → normal RPS resolution.
 * - judgeForfeit:  zero or one move present → either an unopposed win or a tie.
 * - decideMatch:   best-of-three with hard cap at 5 rounds (handles ties extending past 3).
 * - verifyCommit:  hash-binding check for the commit-reveal protocol.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { Move, RoundResult, Side } from "../../types.js";

export function judgeRound(round: number, a: Move, b: Move): RoundResult {
  let winner: Side | "tie";
  if (a === b) winner = "tie";
  else if (
    (a === "rock" && b === "scissors") ||
    (a === "paper" && b === "rock") ||
    (a === "scissors" && b === "paper")
  )
    winner = "a";
  else winner = "b";
  return { round, a, b, winner };
}

export function judgeForfeit(
  round: number,
  present: { side: Side; move: Move | null } | null,
): RoundResult {
  if (!present) {
    return { round, a: null, b: null, winner: "tie", forfeitedBy: "both" };
  }
  // Move may be null when the winner committed but the other side forfeited
  // before reveal phase — there's no obligation for the winner to reveal a
  // walkover, so the move is genuinely unknown.
  return {
    round,
    a: present.side === "a" ? present.move : null,
    b: present.side === "b" ? present.move : null,
    winner: present.side,
    forfeitedBy: present.side === "a" ? "b" : "a",
  };
}

/**
 * Verify a reveal matches a stored commit hash.
 * commit = sha256(`${move}:${nonce}`) as lowercase hex.
 *
 * The nonce binds the commit to a single reveal — without it, the move space
 * is 3 and an attacker could brute-force the hash. With a 16-byte nonce
 * preimage attacks are infeasible.
 */
export function commitHash(move: Move, nonce: string): string {
  return createHash("sha256").update(`${move}:${nonce}`).digest("hex");
}

export function verifyCommit(move: Move, nonce: string, expectedHash: string): boolean {
  const actual = commitHash(move, nonce);
  if (actual.length !== expectedHash.length) return false;
  // timingSafeEqual hardens against tail-comparison side channels even though
  // both inputs here are public hashes — costs nothing.
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expectedHash, "hex"));
}

export function decideMatch(rounds: RoundResult[]): {
  winner: Side | "tie" | null;
  complete: boolean;
} {
  const aWins = rounds.filter((r) => r.winner === "a").length;
  const bWins = rounds.filter((r) => r.winner === "b").length;
  if (aWins >= 2) return { winner: "a", complete: true };
  if (bWins >= 2) return { winner: "b", complete: true };
  if (rounds.length >= 5) {
    if (aWins > bWins) return { winner: "a", complete: true };
    if (bWins > aWins) return { winner: "b", complete: true };
    return { winner: "tie", complete: true };
  }
  return { winner: null, complete: false };
}
