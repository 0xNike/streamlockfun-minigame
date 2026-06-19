/**
 * Gomoku engine: 15×15, freestyle five-in-a-row, players alternate placing
 * stones. Player A always moves first. A player who misses the per-move
 * deadline forfeits the match to their opponent; a full board with no five is a
 * draw (the shell cancels, same as an RPS tie).
 *
 * Perfect-information, so no commit-reveal — the engine just validates that a
 * placement is in-bounds, on an empty cell, and the mover's turn.
 */

import { config } from "../../config.js";
import type { ClientFrame, Side } from "../../types.js";
import type { GameEngine, GameHost, GameProgress } from "../engine.js";
import { type Board, emptyBoard, inBounds, isFull, isWinningMove } from "./rules.js";

const SIZE = 15;

export class GomokuEngine implements GameEngine {
  private readonly board: Board = emptyBoard(SIZE);
  private turn: Side = "a"; // A moves first
  private lastMove: { x: number; y: number; by: Side } | null = null;
  private moveDeadline: number | null = null;
  private moveTimer: NodeJS.Timeout | null = null;
  private destroyed = false;

  constructor(private readonly host: GameHost) {}

  progress(): GameProgress {
    return {
      roundIndex: 0,
      rounds: [],
      state: {
        kind: "gomoku",
        size: SIZE,
        board: this.board,
        turn: this.turn,
        lastMove: this.lastMove,
      },
    };
  }

  start(): void {
    this.announceTurn();
  }

  handleFrame(side: Side, frame: ClientFrame): void {
    if (frame.type !== "place") return; // shell routes the rest
    this.handlePlace(side, frame.x, frame.y);
  }

  private handlePlace(side: Side, x: number, y: number): void {
    if (!this.host.isActive()) {
      this.host.sendError(side, "OUT_OF_ORDER_MOVE", "match not active", false);
      return;
    }
    if (side !== this.turn) {
      this.host.sendError(side, "NOT_YOUR_TURN", "not your turn", false);
      return;
    }
    if (!inBounds(this.board, x, y)) {
      this.host.sendError(side, "OUT_OF_BOUNDS", `(${x},${y}) is off the board`, false);
      return;
    }
    if (this.board[y][x] !== null) {
      this.host.sendError(side, "CELL_TAKEN", `(${x},${y}) is already played`, false);
      return;
    }

    this.board[y][x] = side;
    this.lastMove = { x, y, by: side };
    this.clearMoveTimer();
    this.host.broadcast({ type: "gm_move", ts: this.host.now(), by: side, x, y });
    this.log.info({ side, x, y }, "gomoku.move");

    if (isWinningMove(this.board, x, y, side)) {
      this.log.info({ winner: side }, "gomoku.win");
      this.host.onComplete(side, []);
      return;
    }
    if (isFull(this.board)) {
      this.log.info({}, "gomoku.draw");
      this.host.onComplete("tie", []);
      return;
    }

    this.turn = side === "a" ? "b" : "a";
    this.announceTurn();
  }

  /** Broadcast whose turn it is + the move deadline, and arm the forfeit timer. */
  private announceTurn(): void {
    if (this.destroyed || !this.host.isActive()) return;
    const deadline = this.host.now() + config.GOMOKU_MOVE_DEADLINE_SEC;
    this.moveDeadline = deadline;
    this.host.broadcast({ type: "gm_turn", ts: this.host.now(), turn: this.turn, deadline });
    this.armMoveTimer(config.GOMOKU_MOVE_DEADLINE_SEC);
  }

  private armMoveTimer(seconds: number): void {
    if (this.moveTimer) clearTimeout(this.moveTimer);
    this.moveTimer = setTimeout(() => this.onMoveDeadline(), seconds * 1000);
  }

  private clearMoveTimer(): void {
    if (this.moveTimer) {
      clearTimeout(this.moveTimer);
      this.moveTimer = null;
    }
    this.moveDeadline = null;
  }

  private onMoveDeadline(): void {
    if (!this.host.isActive()) return;
    // The player to move ran out of time → forfeit the match to the opponent.
    const loser = this.turn;
    const winner: Side = loser === "a" ? "b" : "a";
    this.log.warn({ loser }, "gomoku.move_timeout");
    this.host.onComplete(winner, []);
  }

  resync(side: Side): void {
    // The board is rebuilt from the hello snapshot (progress().state); just
    // re-push the live turn + deadline so the reconnecting client's timer is right.
    if (!this.host.isActive() || this.moveDeadline === null) return;
    this.host.sendTo(side, {
      type: "gm_turn",
      ts: this.host.now(),
      turn: this.turn,
      deadline: this.moveDeadline,
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.clearMoveTimer();
  }

  private get log() {
    return this.host.log;
  }
}
