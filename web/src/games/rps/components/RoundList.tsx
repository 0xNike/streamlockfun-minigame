import type { Move, RoundResult, Side } from "../../../shared/types";

const EMOJI: Record<Move, string> = { rock: "✊", paper: "✋", scissors: "✌️" };

function moveCell(m: Move | null) {
  return m ? <span title={m}>{EMOJI[m]}</span> : <span className="dim">—</span>;
}

export function RoundList({ rounds, you }: { rounds: RoundResult[]; you: Side | null }) {
  if (rounds.length === 0) return null;
  return (
    <div className="rounds">
      <h3>Rounds</h3>
      <ol>
        {rounds.map((r) => {
          const youWon = you && r.winner === you;
          const tie = r.winner === "tie";
          return (
            <li key={r.round} className={`round ${tie ? "tie" : youWon ? "win" : "loss"}`}>
              <span className="round__num">#{r.round + 1}</span>
              <span className="round__moves">
                {moveCell(r.a)} <span className="dim">vs</span> {moveCell(r.b)}
              </span>
              <span className="round__verdict">
                {tie
                  ? "tie"
                  : r.forfeitedBy
                  ? `${r.forfeitedBy.toUpperCase()} forfeit → ${r.winner.toUpperCase()}`
                  : `${r.winner.toUpperCase()} wins`}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
