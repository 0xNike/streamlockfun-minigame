/**
 * Chess engine: standard rules via chess.js. White ("a") moves first. A player
 * who misses the per-move deadline forfeits to their opponent. Checkmate ends
 * the match with the mover as winner; any draw (stalemate, threefold, 50-move,
 * insufficient material) ends as a tie, which the shell cancels + refunds.
 *
 * Authoritative: chess.js validates every move (turn, legality, castling, en
 * passant, promotion); illegal moves are rejected with ILLEGAL_MOVE.
 */

import { Chess } from "chess.js";
import { config } from "../../config.js";
import type { ClientFrame, Side } from "../../types.js";
import type { GameEngine, GameHost, GameProgress } from "../engine.js";
import { chessSnapshot, other, sideOf } from "./rules.js";

export class ChessEngine implements GameEngine {
  private readonly game = new Chess();
  private lastMove: { from: string; to: string } | null = null;
  private moveDeadline: number | null = null;
  private moveTimer: NodeJS.Timeout | null = null;
  private destroyed = false;

  constructor(private readonly host: GameHost) {}

  progress(): GameProgress {
    return { roundIndex: 0, rounds: [], state: chessSnapshot(this.game, this.lastMove) };
  }

  start(): void {
    this.announceTurn();
  }

  handleFrame(side: Side, frame: ClientFrame): void {
    if (frame.type !== "chess_move") return; // shell routes the rest
    this.handleMove(side, frame.from, frame.to, frame.promotion);
  }

  private handleMove(
    side: Side,
    from: string,
    to: string,
    promotion?: "q" | "r" | "b" | "n",
  ): void {
    if (!this.host.isActive()) {
      this.host.sendError(side, "OUT_OF_ORDER_MOVE", "match not active", false);
      return;
    }
    if (side !== sideOf(this.game.turn())) {
      this.host.sendError(side, "NOT_YOUR_TURN", "not your turn", false);
      return;
    }

    let move: ReturnType<Chess["move"]>;
    try {
      move = this.game.move({ from, to, promotion });
    } catch {
      // chess.js throws on any illegal move (wrong piece, leaves king in check,
      // missing/invalid promotion, etc.).
      this.host.sendError(side, "ILLEGAL_MOVE", "that move isn't legal", false);
      return;
    }

    this.lastMove = { from: move.from, to: move.to };
    this.clearMoveTimer();
    this.host.broadcast({
      type: "ch_move",
      ts: this.host.now(),
      by: side,
      from: move.from,
      to: move.to,
      san: move.san,
      fen: this.game.fen(),
      check: this.game.inCheck(),
      ...(move.promotion ? { promotion: move.promotion as "q" | "r" | "b" | "n" } : {}),
    });
    this.log.info({ side, san: move.san }, "chess.move");

    if (this.game.isGameOver()) {
      if (this.game.isCheckmate()) {
        this.log.info({ winner: side }, "chess.checkmate");
        this.host.onComplete(side, []); // the mover delivered mate
      } else {
        // stalemate / threefold / 50-move / insufficient material → draw
        this.log.info("chess.draw");
        this.host.onComplete("tie", []);
      }
      return;
    }
    this.announceTurn();
  }

  /** Broadcast whose turn it is + the deadline, arm the forfeit timer. */
  private announceTurn(): void {
    if (this.destroyed || !this.host.isActive()) return;
    const deadline = this.host.now() + config.CHESS_MOVE_DEADLINE_SEC;
    this.moveDeadline = deadline;
    this.host.broadcast({
      type: "ch_turn",
      ts: this.host.now(),
      turn: sideOf(this.game.turn()),
      deadline,
      check: this.game.inCheck(),
    });
    this.armMoveTimer(config.CHESS_MOVE_DEADLINE_SEC);
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
    const loser = sideOf(this.game.turn());
    this.log.warn({ loser }, "chess.move_timeout");
    this.host.onComplete(other(loser), []);
  }

  resync(side: Side): void {
    // Board is rebuilt from the hello snapshot (progress().state FEN); just
    // re-push the live turn + deadline so the reconnecting client's clock is right.
    if (!this.host.isActive() || this.moveDeadline === null) return;
    this.host.sendTo(side, {
      type: "ch_turn",
      ts: this.host.now(),
      turn: sideOf(this.game.turn()),
      deadline: this.moveDeadline,
      check: this.game.inCheck(),
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
