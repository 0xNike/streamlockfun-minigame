/**
 * Pure Gomoku rules. Freestyle: exactly-or-more than five in a row wins
 * (overlines count). No clock, no I/O — trivially testable and auditable.
 *
 * Board is row-major: `board[y][x]`, each cell a Side that played it or null.
 */

import type { Side } from "../../types.js";

export type Cell = Side | null;
export type Board = Cell[][];

export const DEFAULT_SIZE = 15;
export const WIN_RUN = 5;

export function emptyBoard(size: number): Board {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => null as Cell));
}

export function inBounds(board: Board, x: number, y: number): boolean {
  return y >= 0 && y < board.length && x >= 0 && x < board.length;
}

/** True once every cell is filled (a draw if no one has five). */
export function isFull(board: Board): boolean {
  return board.every((row) => row.every((cell) => cell !== null));
}

/**
 * Did the stone just placed at (x, y) by `side` complete a run of WIN_RUN or
 * more? Checks the four axes through that point, counting both directions.
 */
export function isWinningMove(board: Board, x: number, y: number, side: Side): boolean {
  const directions: Array<[number, number]> = [
    [1, 0], // horizontal -
    [0, 1], // vertical |
    [1, 1], // diagonal down-right
    [1, -1], // diagonal up-right
  ];
  for (const [dx, dy] of directions) {
    let run = 1; // the stone itself
    for (const sign of [1, -1]) {
      let cx = x + dx * sign;
      let cy = y + dy * sign;
      while (inBounds(board, cx, cy) && board[cy][cx] === side) {
        run += 1;
        cx += dx * sign;
        cy += dy * sign;
      }
    }
    if (run >= WIN_RUN) return true;
  }
  return false;
}
