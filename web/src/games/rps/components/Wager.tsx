/**
 * Stake disclosure card. Used as pre-create banner on Home and as pre-join
 * confirmation on Match. When a wager snapshot is present, leads with the
 * absolute amount; falls back to bps-only intent display when not.
 */

import type { TokenMetaPublic, WagerSnapshotPublic } from "../../../shared/types";
import { formatToken } from "../../../shared/format";

function shortMint(s: string) {
  return s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
}

function tokenLabel(meta: TokenMetaPublic | null, mint: string) {
  if (meta?.name && meta?.symbol) return `${meta.name} (${meta.symbol})`;
  if (meta?.symbol) return meta.symbol;
  if (meta?.name) return meta.name;
  return shortMint(mint);
}

function safeBigInt(s: string): bigint | null {
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

export function Wager({
  tokenMint,
  tokenMeta,
  stakeBps,
  tokenEnv,
  wager,
  variant = "card",
}: {
  tokenMint: string;
  tokenMeta: TokenMetaPublic | null;
  stakeBps: number;
  tokenEnv: "sol" | "soldev";
  /** When present, the leading display is the absolute amount; bps becomes secondary. */
  wager?: WagerSnapshotPublic | null;
  variant?: "card" | "compact";
}) {
  const pct = (stakeBps / 100).toFixed(2);
  const explorerUrl = `https://app.streamlock.fun/${tokenEnv}/${tokenMint}`;
  const label = tokenLabel(tokenMeta, tokenMint);

  const wagerTokens = wager
    ? formatToken(safeBigInt(wager.amountRaw), tokenMeta?.decimals ?? null, tokenMeta?.symbol ?? null)
    : null;

  if (variant === "compact") {
    return (
      <div className="wager-compact">
        <span className="dim small">Wager</span>
        {wagerTokens ? (
          <strong>
            {wagerTokens}{" "}
            <span className="dim small">
              ({pct}% intent · symmetric absolute)
            </span>
          </strong>
        ) : (
          <strong>
            {pct}% <span className="dim small">({stakeBps} bps) of loser's stream</span>
          </strong>
        )}
        <a href={explorerUrl} target="_blank" rel="noreferrer" className="dim small">
          {label} ↗
        </a>
      </div>
    );
  }

  return (
    <div className="wager">
      <h3>Stake</h3>
      <table className="wager__table">
        <tbody>
          <tr>
            <td>Token</td>
            <td>
              <a href={explorerUrl} target="_blank" rel="noreferrer">
                <strong>{label}</strong>
              </a>
              <span className="dim small"> · {shortMint(tokenMint)} ↗</span>
            </td>
          </tr>
          <tr>
            <td>Wager</td>
            <td>
              {wagerTokens ? (
                <>
                  <strong>{wagerTokens}</strong>
                  <span className="dim small"> · agreed absolute amount, both sides</span>
                  <div className="dim small">
                    Intent: {pct}% of stream. Per-outcome bps:{" "}
                    A loses → {wager!.bpsIfALoses} · B loses → {wager!.bpsIfBLoses}.
                  </div>
                </>
              ) : (
                <>
                  <strong>{pct}%</strong> <span className="dim small">({stakeBps} bps) of loser's stream</span>
                  <div className="dim small">
                    Absolute amount finalized when both players have joined.
                  </div>
                </>
              )}
            </td>
          </tr>
          <tr>
            <td>How it moves</td>
            <td className="small">
              The loser's stream gets reweighted:{" "}
              {wager
                ? "the loser's holder share drops by the agreed amount, the winner's holder share grows by the same."
                : <>
                    <strong>−{stakeBps} bps</strong> from the loser's holder share,{" "}
                    <strong>+{stakeBps} bps</strong> to the winner — both inside the loser's stream.
                  </>}
              {" "}No tokens move; only the entitlement split changes.
            </td>
          </tr>
          <tr>
            <td>Format</td>
            <td className="small">Best of 3 rock-paper-scissors. Tie → no entitlement change, session cancelled.</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
