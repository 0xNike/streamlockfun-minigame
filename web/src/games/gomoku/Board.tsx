import type { Side } from "../../shared/types";

interface BoardProps {
  size: number;
  /** Row-major grid, board[y][x]; each cell is the side that played it, or null. */
  board: (Side | null)[][];
  /** Which side this client is, so its stones render as "yours" (emerald). */
  you: Side | null;
  /** Last placed cell, highlighted. */
  lastMove: { x: number; y: number; by: Side } | null;
  /** True when the local player may place a stone right now. */
  interactive: boolean;
  onPlace: (x: number, y: number) => void;
}

/**
 * Presentational Gomoku grid. Renders a size×size board of cells; empty cells
 * are clickable when `interactive`. Stones are colored by ownership relative to
 * `you` (yours = emerald `--accent`, opponent = `--red`), with the last move
 * ringed. All sizing is driven by CSS so the board scales to the column / phone.
 */
export function Board({ size, board, you, lastMove, interactive, onPlace }: BoardProps) {
  return (
    <div
      className="gomoku-board"
      style={{ gridTemplateColumns: `repeat(${size}, 1fr)` }}
      role="grid"
      aria-label="Gomoku board"
    >
      {Array.from({ length: size }, (_, y) =>
        Array.from({ length: size }, (_, x) => {
          const cell = board[y]?.[x] ?? null;
          const isEmpty = cell === null;
          const isYours = cell !== null && you !== null && cell === you;
          const isLast = !!lastMove && lastMove.x === x && lastMove.y === y;
          const clickable = interactive && isEmpty;
          const classes = [
            "gomoku-cell",
            cell === null ? "" : isYours ? "gomoku-cell--you" : "gomoku-cell--opp",
            isLast ? "gomoku-cell--last" : "",
            clickable ? "gomoku-cell--clickable" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={`${x}-${y}`}
              type="button"
              className={classes}
              role="gridcell"
              aria-label={`row ${y + 1}, column ${x + 1}${
                cell === null ? ", empty" : isYours ? ", your stone" : ", opponent stone"
              }`}
              disabled={!clickable}
              onClick={() => clickable && onPlace(x, y)}
            >
              {cell !== null && <span className="gomoku-stone" aria-hidden="true" />}
            </button>
          );
        }),
      )}
    </div>
  );
}
