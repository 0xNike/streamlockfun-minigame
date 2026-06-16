import { useEffect, useState } from "react";
import type { Move } from "../../../shared/types";

const MOVES: { move: Move; emoji: string; label: string }[] = [
  { move: "rock", emoji: "✊", label: "Rock" },
  { move: "paper", emoji: "✋", label: "Paper" },
  { move: "scissors", emoji: "✌️", label: "Scissors" },
];

export function MoveButtons({
  round,
  deadline,
  disabled,
  onMove,
}: {
  round: number;
  deadline: number | null;
  disabled: boolean;
  onMove: (m: Move) => void;
}) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  const remaining = deadline ? Math.max(0, deadline - now) : null;

  return (
    <div className="moves">
      <div className="moves__head">
        <span>Round {round + 1}</span>
        {remaining !== null && (
          <span className={`countdown ${remaining < 10 ? "danger" : ""}`}>
            {remaining}s
          </span>
        )}
      </div>
      <div className="moves__row">
        {MOVES.map((m) => (
          <button
            key={m.move}
            className={`move-btn move-btn--${m.move}`}
            onClick={() => onMove(m.move)}
            disabled={disabled || remaining === 0}
          >
            <div className="move-btn__emoji">{m.emoji}</div>
            <div className="move-btn__label">{m.label}</div>
          </button>
        ))}
      </div>
      {disabled && <div className="dim small center">Move locked in. Waiting for opponent…</div>}
    </div>
  );
}
