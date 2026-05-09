/**
 * Stake disclosure card. Used as pre-create banner on Home and as pre-join
 * confirmation on Match. Renders the same content in both contexts so a player
 * sees the same information whether they're A or B.
 */

function shortMint(s: string) {
  return s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
}

function tokenLabel(meta: { name: string | null; symbol: string | null } | null, mint: string) {
  if (meta?.name && meta?.symbol) return `${meta.name} (${meta.symbol})`;
  if (meta?.symbol) return meta.symbol;
  if (meta?.name) return meta.name;
  return shortMint(mint);
}

export function Wager({
  tokenMint,
  tokenMeta,
  stakeBps,
  tokenEnv,
  variant = "card",
}: {
  tokenMint: string;
  tokenMeta: { name: string | null; symbol: string | null } | null;
  stakeBps: number;
  tokenEnv: "sol" | "soldev";
  variant?: "card" | "compact";
}) {
  const pct = (stakeBps / 100).toFixed(2);
  const explorerUrl = `https://app.streamlock.fun/${tokenEnv}/${tokenMint}`;
  const cluster = tokenEnv === "sol" ? "mainnet" : "devnet";
  const label = tokenLabel(tokenMeta, tokenMint);

  if (variant === "compact") {
    return (
      <div className="wager-compact">
        <span className="dim small">Stake</span>
        <strong>
          {pct}% <span className="dim small">({stakeBps} bps) of loser's stream</span>
        </strong>
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
              <span className="dim small"> ({cluster})</span>
            </td>
          </tr>
          <tr>
            <td>Wager</td>
            <td>
              <strong>{pct}%</strong> <span className="dim small">({stakeBps} bps)</span>
            </td>
          </tr>
          <tr>
            <td>How it moves</td>
            <td className="small">
              The loser's stream gets reweighted: <strong>−{stakeBps} bps</strong> from the
              loser's holder share, <strong>+{stakeBps} bps</strong> to the winner — both inside
              the loser's stream. No tokens move; only the entitlement split changes.
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
