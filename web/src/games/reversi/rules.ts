/**
 * Client-side Reversi (Othello) rules, 8×8 — a pure port of the server's
 * src/server/games/reversi/rules.ts. Used only for legal-move highlighting and
 * the click guard; authoritative flips arrive from the server's `rv_move`.
 *
 * Board is row-major: `board[y][x]`, each cell a Side ("a"=black, "b"=white) or
 * null. Black ("a") moves first.
 */

import type { Side } from "../../shared/types";

export type Cell = Side | null;
export type Board = Cell[][];
export type Point = { x: number; y: number };

export const SIZE = 8;

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

const other = (s: Side): Side => (s === "a" ? "b" : "a");
const inBounds = (x: number, y: number) => x >= 0 && x < SIZE && y >= 0 && y < SIZE;

/** Standard Othello opening: white on the ↘ diagonal, black on the ↗ diagonal. */
export function initialBoard(): Board {
  const b: Board = Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => null as Cell));
  b[3][3] = "b";
  b[4][4] = "b";
  b[3][4] = "a";
  b[4][3] = "a";
  return b;
}

/** Discs that would flip if `side` plays (x, y). Empty array → not a legal move. */
export function flipsFor(board: Board, x: number, y: number, side: Side): Point[] {
  if (!inBounds(x, y) || board[y][x] !== null) return [];
  const opp = other(side);
  const flips: Point[] = [];
  for (const [dx, dy] of DIRS) {
    const line: Point[] = [];
    let cx = x + dx;
    let cy = y + dy;
    while (inBounds(cx, cy) && board[cy][cx] === opp) {
      line.push({ x: cx, y: cy });
      cx += dx;
      cy += dy;
    }
    if (line.length > 0 && inBounds(cx, cy) && board[cy][cx] === side) {
      flips.push(...line);
    }
  }
  return flips;
}

export function legalMoves(board: Board, side: Side): Point[] {
  const moves: Point[] = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (board[y][x] === null && flipsFor(board, x, y, side).length > 0) moves.push({ x, y });
    }
  }
  return moves;
}

export function counts(board: Board): { a: number; b: number } {
  let a = 0;
  let b = 0;
  for (const row of board) {
    for (const c of row) {
      if (c === "a") a++;
      else if (c === "b") b++;
    }
  }
  return { a, b };
}
