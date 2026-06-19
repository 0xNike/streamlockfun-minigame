/**
 * Wager arithmetic and validation. Pure functions, no I/O.
 *
 * The user-facing primitive is an absolute token amount ("bet 100 LATTE").
 * The on-chain primitive is bps. This module owns the translation, plus the
 * snapshot semantics that keep "what was agreed" stable through the dispute
 * window.
 *
 * Why two snapshots (amount + bps): the amount is the human contract — what
 * each side intentionally signed up for. The bps pair is the machine contract
 * — the exact integer the chain will see, precomputed at agreement time so
 * settlement never has to re-derive it (rounding stays deterministic across
 * crash recovery, replays, and chain reorgs).
 */

import type { Side } from "./types.js";

/* ───────── shapes ───────── */

/**
 * Immutable record of an agreed-to wager. Persisted on the LiveMatch row at
 * the moment B joins. Settlement reads only this — never re-derives.
 */
export interface WagerSnapshot {
  /** Absolute amount in raw u64 base units, BigInt-safe decimal string. */
  amountRaw: string;
  /** stakeBps used to derive amountRaw (kept for display: "this is a 10% match"). */
  stakeBps: number;
  /** Per-side lockedTokenAmount snapshot at agreement time. Frozen for determinism. */
  lockedAtMatchTime: { a: string; b: string };
  /** Loser-bps for each outcome, precomputed. Settlement picks one based on winner. */
  bpsIfALoses: number;
  bpsIfBLoses: number;
}

/**
 * Pre-join offer. P1's view before B exists. The B-side fields are unknown,
 * so we only carry what's needed to validate the joiner against P1's bound.
 */
export interface WagerOffer {
  amountRaw: string;
  stakeBps: number;
  lockedAtMatchTimeA: string;
}

/* ───────── arithmetic ───────── */

/**
 * Smallest amountRaw that produces ≥1 bps in BOTH possible outcomes.
 * Floor must use the larger locked side: `ceil(max(a,b) / 10000)`.
 *
 * Why max not min: if amount/locked < 1/10000 for either side, that outcome
 * silently no-ops on-chain (deltaBps rounds to 0) — a sneaky integrity bug
 * that only triggers when the two streams differ wildly in size. Reject
 * before agreement.
 */
export function minWagerForPair(lockedA: bigint, lockedB: bigint): bigint {
  const larger = lockedA > lockedB ? lockedA : lockedB;
  // ceil(larger / 10000)
  return (larger + 9999n) / 10000n;
}

/**
 * Largest amountRaw the protocol will accept. Either side's bps must fit in
 * [1, 10000], so amountRaw ≤ min(lockedA, lockedB).
 *
 * Note: this is the protocol cap. The matchmaking cohort band (e.g. ratio ≤
 * 5x) is a separate, tighter, policy-level cap enforced at create/join time.
 */
export function maxWagerForPair(lockedA: bigint, lockedB: bigint): bigint {
  return lockedA < lockedB ? lockedA : lockedB;
}

/**
 * Loser-bps from a wager amount and the loser's locked. Round UP so the
 * winner is never under-credited by 1 base unit. Loser eats at most 1 unit
 * of rounding noise.
 *
 * Returns 0 if `loserLocked === 0` — caller must reject before submit.
 */
export function bpsForOutcome(amountRaw: bigint, loserLocked: bigint): number {
  if (loserLocked <= 0n) return 0;
  const bps = (amountRaw * 10000n + loserLocked - 1n) / loserLocked; // ceil division
  // i16 fits the on-chain ledger; cap at 10000 (full position).
  if (bps > 10000n) return 10000;
  return Number(bps);
}

/* ───────── validation ───────── */

export type WagerValidation =
  | { ok: true; snapshot: WagerSnapshot }
  | { ok: false; code: WagerError; message: string };

export type WagerError =
  | "AMOUNT_BELOW_FLOOR" // would round to 0 bps for at least one side
  | "AMOUNT_ABOVE_CAP" // exceeds the smaller side's locked
  | "AMOUNT_INVALID" // not a positive integer string
  | "LOCKED_MISSING" // a stream is missing lockedTokenAmount (legacy/null)
  | "STREAMS_UNAVAILABLE" // couldn't read stream sizes (transient) — retry, don't downgrade
  | "COHORT_MISMATCH"; // exceeds tolerance band (policy-level)

/**
 * Materialise a validated WagerSnapshot at the moment B joins.
 *
 * `cohortMaxRatio` enforces the matchmaking tolerance band (e.g. 5 means
 * larger ≤ 5× smaller). Pass Infinity to disable.
 */
export function materialiseWager(args: {
  amountRaw: string;
  stakeBps: number;
  lockedA: string | null;
  lockedB: string | null;
  cohortMaxRatio?: number;
}): WagerValidation {
  if (args.lockedA == null || args.lockedB == null) {
    return {
      ok: false,
      code: "LOCKED_MISSING",
      message: "amount-based wager requires lockedTokenAmount on both streams",
    };
  }

  let amount: bigint;
  let lockedA: bigint;
  let lockedB: bigint;
  try {
    amount = BigInt(args.amountRaw);
    lockedA = BigInt(args.lockedA);
    lockedB = BigInt(args.lockedB);
  } catch {
    return { ok: false, code: "AMOUNT_INVALID", message: "amount/locked must be u64-safe strings" };
  }
  if (amount <= 0n) {
    return { ok: false, code: "AMOUNT_INVALID", message: "amount must be positive" };
  }

  const ratio = Number(
    lockedA > lockedB
      ? (lockedA * 1000n) / (lockedB || 1n)
      : (lockedB * 1000n) / (lockedA || 1n),
  ) / 1000;
  const maxRatio = args.cohortMaxRatio ?? Infinity;
  if (ratio > maxRatio) {
    return {
      ok: false,
      code: "COHORT_MISMATCH",
      message: `stream sizes differ by ${ratio.toFixed(1)}× (max ${maxRatio}×)`,
    };
  }

  const floor = minWagerForPair(lockedA, lockedB);
  if (amount < floor) {
    return {
      ok: false,
      code: "AMOUNT_BELOW_FLOOR",
      message: `wager ${amount} below floor ${floor} (would round to 0 bps for the larger side)`,
    };
  }

  const cap = maxWagerForPair(lockedA, lockedB);
  if (amount > cap) {
    return {
      ok: false,
      code: "AMOUNT_ABOVE_CAP",
      message: `wager ${amount} exceeds smaller side's locked ${cap}`,
    };
  }

  return {
    ok: true,
    snapshot: {
      amountRaw: amount.toString(),
      stakeBps: args.stakeBps,
      lockedAtMatchTime: { a: lockedA.toString(), b: lockedB.toString() },
      bpsIfALoses: bpsForOutcome(amount, lockedA),
      bpsIfBLoses: bpsForOutcome(amount, lockedB),
    },
  };
}

/** Pick the loser-bps to send to the chain at settlement time. */
export function loserBpsFromSnapshot(snap: WagerSnapshot, loser: Side): number {
  return loser === "a" ? snap.bpsIfALoses : snap.bpsIfBLoses;
}

/**
 * Convenience: derive amountRaw from a stakeBps + a pair's locked amounts.
 * Used when the matchmaker gives a percentage and we need the equivalent
 * absolute. Formula: stakeBps × min(lockedA, lockedB) / 10000.
 */
export function amountFromStakeBps(
  stakeBps: number,
  lockedA: bigint,
  lockedB: bigint,
): bigint {
  const smaller = lockedA < lockedB ? lockedA : lockedB;
  return (smaller * BigInt(stakeBps)) / 10000n;
}
