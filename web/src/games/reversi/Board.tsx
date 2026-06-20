import type { Side } from "../../shared/types";

interface BoardProps {
  size: number;
  /** Row-major grid, board[y][x]; "a"=black / "b"=white / null. */
  board: (Side | null)[][];
  /** Last placed cell, highlighted. */
  lastMove: { x: number; y: number; by: Side } | null;
  /** Cells the current player may legally play, as a set of "x,y" keys. */
  legal: Set<string>;
  /** True when the local player may place a disc right now. */
  interactive: boolean;
  onPlace: (x: number, y: number) => void;
}

/**
 * Presentational Reversi grid. Discs carry fixed identities (NOT per-viewer):
 * `a` = a light disc (zinc-100), `b` = the orange accent. Empty legal cells are
 * marked with a subtle dot when it's the local player's turn; the last move is
 * ringed. All sizing is driven by CSS so the board scales to the column / phone.
 */
export function Board({ size, board, lastMove, legal, interactive, onPlace }: BoardProps) {
  return (
    <div
      className="reversi-board"
      style={{ gridTemplateColumns: `repeat(${size}, 1fr)` }}
      role="grid"
      aria-label="Reversi board"
    >
      {Array.from({ length: size }, (_, y) =>
        Array.from({ length: size }, (_, x) => {
          const cell = board[y]?.[x] ?? null;
          const isEmpty = cell === null;
          const isLegal = isEmpty && legal.has(`${x},${y}`);
          const isLast = !!lastMove && lastMove.x === x && lastMove.y === y;
          const clickable = interactive && isLegal;
          const classes = [
            "reversi-cell",
            cell === "a" ? "reversi-cell--a" : "",
            cell === "b" ? "reversi-cell--b" : "",
            isLegal && interactive ? "reversi-cell--legal" : "",
            isLast ? "reversi-cell--last" : "",
            clickable ? "reversi-cell--clickable" : "",
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
                cell === null
                  ? isLegal && interactive
                    ? ", empty, legal move"
                    : ", empty"
                  : cell === "a"
                    ? ", black disc"
                    : ", white disc"
              }`}
              disabled={!clickable}
              onClick={() => clickable && onPlace(x, y)}
            >
              {cell !== null && <span className="reversi-disc" aria-hidden="true" />}
            </button>
          );
        }),
      )}
    </div>
  );
}
