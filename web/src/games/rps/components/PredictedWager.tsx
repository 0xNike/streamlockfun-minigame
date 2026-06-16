/**
 * Pre-join preview of the wager that's about to be agreed to.
 *
 * Mirrors the server's `tryMaterialiseWager` math client-side so the joiner
 * sees the absolute amount + cohort warning BEFORE clicking Confirm. Server
 * still re-validates and is the source of truth — this is informed-consent
 * UX, not a security boundary.
 */

import type { TokenMetaPublic } from "../../../shared/types";
import { formatToken } from "../../../shared/format";

export function PredictedWager({
  lockedA,
  lockedB,
  stakeBps,
  tokenMeta,
  cohortMaxRatio,
}: {
  /** P1's locked amount as raw u64 string. */
  lockedA: string | null | undefined;
  /** Joiner's locked amount as raw u64 string. */
  lockedB: string | null | undefined;
  stakeBps: number;
  tokenMeta: TokenMetaPublic | null | undefined;
  cohortMaxRatio: number;
}) {
  if (!lockedA || !lockedB) {
    return (
      <div className="predicted">
        <div className="predicted__title">Predicted wager</div>
        <div className="dim small">
          Stream sizes unavailable — wager will fall back to {(stakeBps / 100).toFixed(2)}% of the
          loser's stream (legacy mode).
        </div>
      </div>
    );
  }

  let lockedABig: bigint;
  let lockedBBig: bigint;
  try {
    lockedABig = BigInt(lockedA);
    lockedBBig = BigInt(lockedB);
  } catch {
    return null;
  }
  if (lockedABig <= 0n || lockedBBig <= 0n) return null;

  const larger = lockedABig > lockedBBig ? lockedABig : lockedBBig;
  const smaller = lockedABig < lockedBBig ? lockedABig : lockedBBig;
  const ratio = Number((larger * 1000n) / smaller) / 1000;
  const cohortFails = ratio > cohortMaxRatio;

  // Mirror server: amount = stakeBps × min(locked) / 10000, clamped to min(locked).
  const fromBps = (smaller * BigInt(stakeBps)) / 10000n;
  const amount = fromBps;

  const amountTokens = formatToken(
    amount,
    tokenMeta?.decimals ?? null,
    tokenMeta?.symbol ?? null,
  );

  const yourLocked = lockedBBig;
  const oppLocked = lockedABig;
  const yourLoseBps =
    yourLocked > 0n ? Number((amount * 10000n + yourLocked - 1n) / yourLocked) : 0;
  const oppLoseBps =
    oppLocked > 0n ? Number((amount * 10000n + oppLocked - 1n) / oppLocked) : 0;

  if (cohortFails) {
    return (
      <div className="predicted predicted--reject">
        <div className="predicted__title">Wager mismatch</div>
        <div>
          The opponent's stream is <strong>{ratio.toFixed(1)}×</strong> yours — exceeds the{" "}
          <strong>{cohortMaxRatio}×</strong> matchmaking band.
        </div>
        <div className="dim small">
          The server will reject this join. Find a more evenly-matched opponent.
        </div>
      </div>
    );
  }

  return (
    <div className="predicted">
      <div className="predicted__title">Predicted wager</div>
      <div className="predicted__amount">
        Both sides risk <strong>{amountTokens ?? `${(stakeBps / 100).toFixed(2)}% of stream`}</strong>
        .
      </div>
      <div className="dim small">
        For you, that's <strong>{(yourLoseBps / 100).toFixed(2)}%</strong> of your stream
        {oppLoseBps !== yourLoseBps && (
          <> · for the opponent, <strong>{(oppLoseBps / 100).toFixed(2)}%</strong> of theirs</>
        )}
        .
      </div>
    </div>
  );
}
