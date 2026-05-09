import type { MatchSnapshot, Side } from "../types";
import { formatToken, stakeBaseUnits } from "../format";

function shortAddr(s: string) {
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

function pct(bps: number) {
  return `${(bps / 100).toFixed(2)}%`;
}

export function Outcome({ snap, you }: { snap: MatchSnapshot; you: Side | null }) {
  const winner = snap.winner;
  if (!winner) return null;

  const aWins = snap.rounds.filter((r) => r.winner === "a").length;
  const bWins = snap.rounds.filter((r) => r.winner === "b").length;
  const score = `${aWins}–${bWins}`;
  const symbol = snap.tokenMeta?.symbol ?? "stream";

  if (winner === "tie") {
    return (
      <div className="hero hero--tie">
        <div className="hero__verdict">It's a tie</div>
        <div className="hero__score">{score}</div>
        <div className="hero__sub">
          No {symbol} moved. Your match is being cancelled and any setup costs refunded.
        </div>
      </div>
    );
  }

  const winnerSlot = winner === "a" ? snap.playerA : snap.playerB;
  const loserSlot = winner === "a" ? snap.playerB : snap.playerA;
  const youWon = you === winner;
  const stakePct = pct(snap.bpsAtStake);

  // Wager in absolute token units = loser's lockedTokenAmount × stakeBps / 10000.
  const wagerTokens = formatToken(
    stakeBaseUnits(loserSlot?.lockedTokenAmount ?? null, snap.bpsAtStake),
    snap.tokenMeta?.decimals ?? null,
    snap.tokenMeta?.symbol ?? null,
  );

  return (
    <div className={`hero ${youWon ? "hero--win" : "hero--loss"}`}>
      <div className="hero__verdict">{youWon ? "🏆 You won!" : "💀 You lost"}</div>
      <div className="hero__score">{score}</div>
      <div className="hero__sub">
        {youWon ? (
          <>
            You earned{" "}
            <strong>
              {wagerTokens ?? `${stakePct} of the stream`}
            </strong>
            {wagerTokens && <span className="dim small"> ({stakePct} of the stream)</span>}
            {loserSlot && (
              <>
                {" "}from <code>{shortAddr(loserSlot.wallet)}</code>
              </>
            )}
            .
          </>
        ) : (
          <>
            {winnerSlot && (
              <>
                <code>{shortAddr(winnerSlot.wallet)}</code>{" "}
              </>
            )}
            took{" "}
            <strong>
              {wagerTokens ?? `${stakePct} of your stream`}
            </strong>
            {wagerTokens && <span className="dim small"> ({stakePct} of your stream)</span>}
            .
          </>
        )}
      </div>

      {winnerSlot && loserSlot && (
        <details className="hero__details">
          <summary>Technical details</summary>
          <table className="outcome__table">
            <tbody>
              <tr>
                <td className="dim">Stake</td>
                <td>
                  {snap.bpsAtStake} bps ({stakePct} of the loser's stream)
                  {wagerTokens && <span className="dim small"> · {wagerTokens}</span>}
                </td>
              </tr>
              <tr>
                <td className="dim">Winner</td>
                <td>
                  <strong>{winner.toUpperCase()}</strong> — {shortAddr(winnerSlot.wallet)}
                  <div className="dim small">
                    +{snap.bpsAtStake} bps inside stream {shortAddr(loserSlot.streamId)}
                  </div>
                </td>
              </tr>
              <tr>
                <td className="dim">Loser</td>
                <td>
                  <strong>{winner === "a" ? "B" : "A"}</strong> — {shortAddr(loserSlot.wallet)}
                  <div className="dim small">
                    −{snap.bpsAtStake} bps inside stream {shortAddr(loserSlot.streamId)} (own stream)
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}
