import type { Side } from "../../shared/types";

/** White = "a" (moves first), Black = "b". chess.js uses "w"/"b". */
export const sideOf = (color: "w" | "b"): Side => (color === "w" ? "a" : "b");
export const colorOf = (s: Side): "w" | "b" => (s === "a" ? "w" : "b");

/** Standard starting position FEN. */
export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
