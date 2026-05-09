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

import type { PlayerSlotSnapshot, TokenMetaPublic } from "../types";
import { formatToken, stakeBaseUnits } from "../format";

function fmtPct(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
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
}: {
  playerA: PlayerSlotSnapshot;
  playerB: PlayerSlotSnapshot | null;
  bpsAtStake: number;
  youSide: "a" | "b" | null;
  tokenMeta?: TokenMetaPublic | null;
}) {
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
          The wager is <strong>{wagerPct}</strong> of the loser's stream.
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
  const yourAfterLoss = yourBps !== null ? Math.max(0, yourBps - bpsAtStake) : null;
  const yourSol = fmtSol(yours?.entitledLamports ?? null);

  const yourWagerTokens = wagerAmount(yours, bpsAtStake, tokenMeta);
  const oppWagerTokens = wagerAmount(opp, bpsAtStake, tokenMeta);

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
            You take <strong>+{wagerPct}</strong>
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
                <span className="dim"> · −{wagerPct} of your stream.</span>
              </>
            ) : (
              <>
                You give up <strong>{yourWagerTokens ?? `${wagerPct} of your stream`}</strong>
                {yourWagerTokens && (
                  <span className="dim small"> ({wagerPct} of your stream)</span>
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
