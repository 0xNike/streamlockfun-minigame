/**
 * Game module boundary.
 *
 * The match shell (matches.ts `LiveMatch`) owns everything game-agnostic:
 * matchmaking, the on-chain session lifecycle, settlement, sockets, snapshots,
 * abandonment. A `GameEngine` owns the gameplay between "session is active" and
 * "we have a winner" — for RPS that's the commit-reveal round loop.
 *
 * The shell drives the engine (start / handleFrame / resync / destroy) and the
 * engine talks back through a `GameHost`. When play resolves, the engine calls
 * `host.onComplete(winner, rounds)` and the shell takes over for settlement.
 *
 * To add a game: implement `GameEngine` + `GameDefinition` and register it in
 * registry.ts. Nothing else in the shell changes.
 */

import type WebSocket from "ws";
import type { Logger } from "../log.js";
import type { ClientFrame, ErrorCode, RoundResult, ServerFrame, Side } from "../types.js";

/** The slice of the match shell an engine is allowed to touch. */
export interface GameHost {
  readonly matchId: string;
  readonly log: Logger;
  /** Unix seconds, via the shell's clock. */
  now(): number;
  /** True only while the match is in the `active` play state and not torn down. */
  isActive(): boolean;
  broadcast(frame: ServerFrame): void;
  sendTo(side: Side, frame: ServerFrame): void;
  sendError(side: Side, code: ErrorCode, message: string, fatal: boolean): void;
  /** The live socket for a side, or null if disconnected. Used to re-push state. */
  socketFor(side: Side): WebSocket | null;
  /** Called once when gameplay produces a final result; hands off to settlement. */
  onComplete(winner: Side | "tie", rounds: RoundResult[]): void;
}

/** Play progress exposed to the shell's match snapshot. */
export interface GameProgress {
  roundIndex: number;
  rounds: RoundResult[];
}

export interface GameEngine {
  /** Begin play (first round). Called once, after the on-chain session exists. */
  start(): void;
  /** Handle a gameplay client frame. Non-gameplay frames (pong/leave/resync) are
   *  routed by the shell and never reach here. */
  handleFrame(side: Side, frame: ClientFrame): void;
  /** Re-push any phase state a reconnecting socket may have missed. */
  resync(side: Side): void;
  /** Stop timers / mark torn down. Idempotent. */
  destroy(): void;
  /** Current play progress, for the match snapshot. */
  progress(): GameProgress;
}

export interface GameDefinition {
  readonly id: string;
  readonly title: string;
  createEngine(host: GameHost): GameEngine;
}
