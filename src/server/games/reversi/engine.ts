/**
 * Reversi engine: 8×8 Othello. Black ("a") moves first. A player who has no
 * legal move is auto-skipped; when neither side can move (or the board is full)
 * the game ends and the winner is whoever has more discs (equal → tie, which
 * the shell cancels like an RPS tie). A player who misses the per-move deadline
 * forfeits the match to their opponent.
 *
 * Perfect-information; the engine validates that a placement is the mover's
 * turn, on an empty in-bounds cell, and actually outflanks (flips ≥ 1).
 */

import { config } from "../../config.js";
import type { ClientFrame, Side } from "../../types.js";
import type { GameEngine, GameHost, GameProgress } from "../engine.js";
import {
  type Board,
  SIZE,
  applyMove,
  counts,
  decideWinner,
  hasLegalMove,
  initialBoard,
  isLegalMove,
} from "./rules.js";

const other = (s: Side): Side => (s === "a" ? "b" : "a");

export class ReversiEngine implements GameEngine {
  private readonly board: Board = initialBoard();
  private turn: Side = "a"; // black moves first
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
        kind: "reversi",
        size: SIZE,
        board: this.board,
        turn: this.turn,
        lastMove: this.lastMove,
        counts: counts(this.board),
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
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) {
      this.host.sendError(side, "OUT_OF_BOUNDS", `(${x},${y}) is off the board`, false);
      return;
    }
    if (this.board[y][x] !== null) {
      this.host.sendError(side, "CELL_TAKEN", `(${x},${y}) is already played`, false);
      return;
    }
    if (!isLegalMove(this.board, x, y, side)) {
      this.host.sendError(side, "ILLEGAL_MOVE", "that move doesn't flank any discs", false);
      return;
    }

    const flipped = applyMove(this.board, x, y, side);
    this.lastMove = { x, y, by: side };
    this.clearMoveTimer();
    this.host.broadcast({ type: "rv_move", ts: this.host.now(), by: side, x, y, flipped });
    this.log.info({ side, x, y, flips: flipped.length }, "reversi.move");

    // Whose turn next — auto-skip a side with no legal move; end if neither can.
    const opp = other(side);
    if (hasLegalMove(this.board, opp)) {
      this.turn = opp;
      this.announceTurn();
    } else if (hasLegalMove(this.board, side)) {
      // Opponent has no move → they pass, mover goes again.
      this.announceTurn(opp);
    } else {
      const winner = decideWinner(this.board);
      this.log.info({ winner, counts: counts(this.board) }, "reversi.end");
      this.host.onComplete(winner, []);
    }
  }

  /** Broadcast whose turn it is + the deadline, arm the forfeit timer.
   *  `autoPassed` names a side that was skipped (had no legal move), for UI. */
  private announceTurn(autoPassed?: Side): void {
    if (this.destroyed || !this.host.isActive()) return;
    const deadline = this.host.now() + config.REVERSI_MOVE_DEADLINE_SEC;
    this.moveDeadline = deadline;
    this.host.broadcast({
      type: "rv_turn",
      ts: this.host.now(),
      turn: this.turn,
      deadline,
      ...(autoPassed ? { autoPassed } : {}),
    });
    this.armMoveTimer(config.REVERSI_MOVE_DEADLINE_SEC);
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
    const loser = this.turn;
    const winner = other(loser);
    this.log.warn({ loser }, "reversi.move_timeout");
    this.host.onComplete(winner, []);
  }

  resync(side: Side): void {
    // Board is rebuilt from the hello snapshot (progress().state); just re-push
    // the live turn + deadline so the reconnecting client's timer is right.
    if (!this.host.isActive() || this.moveDeadline === null) return;
    this.host.sendTo(side, {
      type: "rv_turn",
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
