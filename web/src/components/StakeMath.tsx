/**
 * Concrete stake math display.
 *
 * Translates "10% of the loser's stream" into per-side numbers using each
 * player's effectiveBps (% share). When the stream's lockedTokenAmount and the
 * token's decimals are known, also shows the wager in absolute token units
 * (e.g. "12.345 STREAM"); falls back to bps-only when either is missing.
 *
 * Lines whose only datum is null are *omitted* rather than rendered with an
 * em-dash placeholder — a partially-loaded snapshot should look like fewer
 * facts, not stale facts.
 */

import type { PlayerSlotSnapshot, TokenMetaPublic, WagerSnapshotPublic } from "../types";
import { formatToken, stakeBaseUnits } from "../format";

function fmtPct(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

function safeBigInt(s: string): bigint | null {
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

function fmtSol(lamports: string | null): string | null {
  if (!lamports || lamports === "0") return null;
  const n = Number(lamports);
  if (!Number.isFinite(n)) return null;
  return `${(n / 1e9).toFixed(6)} SOL`;
}

function wagerAmount(
  slot: PlayerSlotSnapshot | null | undefined,
  bpsAtStake: number,
  tokenMeta: TokenMetaPublic | null | undefined,
): string | null {
  if (!slot) return null;
  return formatToken(
    stakeBaseUnits(slot.lockedTokenAmount, bpsAtStake),
    tokenMeta?.decimals ?? null,
    tokenMeta?.symbol ?? null,
  );
}

export function StakeMath({
  playerA,
  playerB,
  bpsAtStake,
  youSide,
  tokenMeta,
  wager,
}: {
  playerA: PlayerSlotSnapshot;
  playerB: PlayerSlotSnapshot | null;
  bpsAtStake: number;
  youSide: "a" | "b" | null;
  tokenMeta?: TokenMetaPublic | null;
  wager?: WagerSnapshotPublic | null;
}) {
  // When a wager snapshot exists, the absolute amount is canonical and per-side
  // bps are precomputed (rounding-safe). Display follows the snapshot.
  const wagerAmountTokens = wager
    ? formatToken(safeBigInt(wager.amountRaw), tokenMeta?.decimals ?? null, tokenMeta?.symbol ?? null)
    : null;
  // Headline percentage: when there's a snapshot, "% of your own stream" differs
  // per side — show stakeBps as the original intent, but per-side bps in the cards.
  const wagerPct = fmtPct(bpsAtStake);

  if (!youSide) {
    const aBps = playerA.effectiveBps;
    const bBps = playerB?.effectiveBps ?? null;
    const summaryParts: string[] = [];
    if (aBps !== null) summaryParts.push(`Player A holds ${fmtPct(aBps)} of their stream`);
    if (bBps !== null) summaryParts.push(`Player B holds ${fmtPct(bBps)} of theirs`);

    return (
      <div className="stake-math">
        <h3>Stake math</h3>
        <p>
          The wager is{" "}
          <strong>{wagerAmountTokens ?? `${wagerPct} of the loser's stream`}</strong>
          {wagerAmountTokens && <span className="dim small"> ({wagerPct} intent)</span>}.
        </p>
        {summaryParts.length > 0 && (
          <p className="dim small">{summaryParts.join(" · ")}.</p>
        )}
      </div>
    );
  }

  const yours = youSide === "a" ? playerA : playerB;
  const opp = youSide === "a" ? playerB : playerA;
  const yourBps = yours?.effectiveBps ?? null;
  const oppBps = opp?.effectiveBps ?? null;

  // With a snapshot, the bps each side gives up if they lose is precomputed —
  // and per-side, not symmetric. Without a snapshot, fall back to bpsAtStake.
  const yourLoseBps = wager
    ? youSide === "a"
      ? wager.bpsIfALoses
      : wager.bpsIfBLoses
    : bpsAtStake;
  const oppLoseBps = wager
    ? youSide === "a"
      ? wager.bpsIfBLoses
      : wager.bpsIfALoses
    : bpsAtStake;
  const yourLosePct = fmtPct(yourLoseBps);
  const oppLosePct = fmtPct(oppLoseBps);

  const yourAfterLoss = yourBps !== null ? Math.max(0, yourBps - yourLoseBps) : null;
  const yourSol = fmtSol(yours?.entitledLamports ?? null);

  // With a snapshot, the wager amount is the same on both sides (that's the
  // whole point of A) — use the snapshot's amount. Without one, fall back to
  // each side's locked × bps derivation.
  const yourWagerTokens = wagerAmountTokens ?? wagerAmount(yours, bpsAtStake, tokenMeta);
  const oppWagerTokens = wagerAmountTokens ?? wagerAmount(opp, bpsAtStake, tokenMeta);

  return (
    <div className="stake-math">
      <h3>Stake math</h3>
      <p>
        Wager: <strong>{wagerPct}</strong> of the loser's stream.
      </p>
      {yourBps !== null && (
        <p>
          You currently hold <strong>{fmtPct(yourBps)}</strong> of your stream.
        </p>
      )}

      <div className="stake-math__outcomes">
        <div className="stake-math__outcome win">
          <div className="stake-math__outcome-label">If you WIN</div>
          <div>
            You take <strong>+{oppLosePct}</strong>
            {oppWagerTokens && <> ({oppWagerTokens})</>}{" "}of the opponent's stream.
          </div>
        </div>
        <div className="stake-math__outcome loss">
          <div className="stake-math__outcome-label">If you LOSE</div>
          <div>
            {yourAfterLoss !== null ? (
              <>
                Your share drops to <strong>{fmtPct(yourAfterLoss)}</strong>
                {yourWagerTokens && (
                  <>
                    {" "}<span className="dim">(−{yourWagerTokens})</span>
                  </>
                )}
                <span className="dim"> · −{yourLosePct} of your stream.</span>
              </>
            ) : (
              <>
                You give up <strong>{yourWagerTokens ?? `${yourLosePct} of your stream`}</strong>
                {yourWagerTokens && (
                  <span className="dim small"> ({yourLosePct} of your stream)</span>
                )}
                .
              </>
            )}
          </div>
        </div>
      </div>

      {opp && oppBps !== null && (
        <p className="dim small">
          Opponent holds <strong>{fmtPct(oppBps)}</strong> of their stream.
        </p>
      )}
      {yourSol && (
        <p className="dim small">
          Your current SOL entitlement: <strong>{yourSol}</strong>.
        </p>
      )}
    </div>
  );
}
