/**
 * Chess helpers. The rules themselves live in `chess.js` (legal-move generation,
 * check/checkmate/stalemate, castling, en passant, promotion, and every draw
 * type). This module only maps chess.js state onto our wire types.
 */

import type { Chess } from "chess.js";
import type { ChessSnapshot, Side } from "../../types.js";

/** White moves first → "a"; Black → "b". */
export const sideOf = (color: "w" | "b"): Side => (color === "w" ? "a" : "b");
export const other = (s: Side): Side => (s === "a" ? "b" : "a");

/** Build the wire snapshot from a live game. FEN captures the whole position. */
export function chessSnapshot(
  game: Chess,
  lastMove: { from: string; to: string } | null,
): ChessSnapshot {
  return {
    kind: "chess",
    fen: game.fen(),
    turn: sideOf(game.turn()),
    lastMove,
    check: game.inCheck(),
  };
}
