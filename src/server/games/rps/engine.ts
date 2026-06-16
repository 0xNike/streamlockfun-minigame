/**
 * RPS gameplay engine: the commit-reveal best-of-three round loop.
 *
 * Extracted verbatim from the old LiveMatch round machinery — same protocol,
 * same timers, same forfeit/bad-reveal semantics. The only change is that it no
 * longer owns match state or settlement: it reads the shell through `GameHost`
 * and, when the match resolves, calls `host.onComplete(winner, rounds)`.
 *
 * Round flow: commit phase → reveal phase → judge.
 *   pendingCommits — sha256(move:nonce) seen so far, by side.
 *   pendingReveals — verified (move, nonce) pairs, by side.
 *   failedReveals  — sides whose reveal hash didn't match their commit. Treated
 *                    the same as a forfeit for resolution; the audit trail is
 *                    the DB row's commit_hash + missing reveal.
 *   forfeitedSides — sides that explicitly sent `forfeit_round`.
 *
 * A side is "in the running" iff they committed AND are not in failedReveals or
 * forfeitedSides. Only validly-revealed moves count as plays.
 */

import { config } from "../../config.js";
import { insertCommit, recordReveal, setRounds } from "../../db.js";
import type { ClientFrame, Move, RoundResult, Side } from "../../types.js";
import type { GameEngine, GameHost, GameProgress } from "../engine.js";
import { decideMatch, judgeForfeit, judgeRound, verifyCommit } from "./rules.js";

export class RpsEngine implements GameEngine {
  private roundIndex = 0;
  private rounds: RoundResult[] = [];
  private pendingCommits: Map<Side, string> = new Map();
  private pendingReveals: Map<Side, { move: Move; nonce: string }> = new Map();
  private failedReveals: Set<Side> = new Set();
  private forfeitedSides: Set<Side> = new Set();
  private roundPhase: "commit" | "reveal" = "commit";
  private phaseDeadline: number | null = null;
  private phaseTimer: NodeJS.Timeout | null = null;
  private destroyed = false;

  constructor(private readonly host: GameHost) {}

  progress(): GameProgress {
    return { roundIndex: this.roundIndex, rounds: this.rounds };
  }

  private get log() {
    return this.host.log;
  }

  start(): void {
    this.startRound();
  }

  handleFrame(side: Side, frame: ClientFrame): void {
    switch (frame.type) {
      case "commit":
        this.handleCommit(side, frame.round, frame.commitHash);
        return;
      case "reveal":
        this.handleReveal(side, frame.round, frame.move, frame.nonce);
        return;
      case "forfeit_round":
        if (!this.host.isActive()) {
          this.host.sendError(side, "OUT_OF_ORDER_MOVE", `match not active`, false);
          return;
        }
        if (frame.round !== this.roundIndex) {
          this.host.sendError(side, "OUT_OF_ORDER_MOVE", `expected round ${this.roundIndex}`, false);
          return;
        }
        this.handleForfeit(side);
        return;
      default:
        // Non-gameplay frames are routed by the shell; nothing to do here.
        return;
    }
  }

  // ───────── round lifecycle ─────────

  private startRound(): void {
    if (this.destroyed || !this.host.isActive()) return;
    this.pendingCommits.clear();
    this.pendingReveals.clear();
    this.failedReveals.clear();
    this.forfeitedSides.clear();
    this.roundPhase = "commit";
    const deadline = this.host.now() + config.ROUND_DEADLINE_SEC;
    this.phaseDeadline = deadline;
    this.host.broadcast({ type: "round_start", ts: this.host.now(), round: this.roundIndex, deadline });
    this.log.info({ round: this.roundIndex, phase: "commit", deadline }, "round.start");
    this.armPhaseTimer(config.ROUND_DEADLINE_SEC);
  }

  private startRevealPhase(): void {
    if (this.destroyed || !this.host.isActive()) return;
    this.roundPhase = "reveal";
    const deadline = this.host.now() + config.REVEAL_DEADLINE_SEC;
    this.phaseDeadline = deadline;
    const aHash = this.pendingCommits.get("a");
    const bHash = this.pendingCommits.get("b");
    if (!aHash || !bHash) {
      // Defensive: only call this once both commits are in.
      this.log.error({ aHash: !!aHash, bHash: !!bHash }, "reveal_phase.missing_commit");
      return;
    }
    this.host.broadcast({
      type: "commits_locked",
      ts: this.host.now(),
      round: this.roundIndex,
      deadline,
      commits: { a: aHash, b: bHash },
    });
    this.log.info({ round: this.roundIndex, phase: "reveal", deadline }, "phase.reveal");
    this.armPhaseTimer(config.REVEAL_DEADLINE_SEC);
  }

  private armPhaseTimer(seconds: number): void {
    if (this.phaseTimer) clearTimeout(this.phaseTimer);
    this.phaseTimer = setTimeout(() => this.onPhaseDeadline(), seconds * 1000);
  }

  private onPhaseDeadline(): void {
    if (!this.host.isActive()) return;
    this.log.warn({ round: this.roundIndex, phase: this.roundPhase }, "phase.deadline_hit");
    this.judgeAndAdvance();
  }

  private clearPhaseTimer(): void {
    if (this.phaseTimer) {
      clearTimeout(this.phaseTimer);
      this.phaseTimer = null;
    }
    this.phaseDeadline = null;
  }

  /** Round ends as soon as every side is in a terminal sub-state for the round. */
  private checkRoundCompletion(): void {
    const sides: Side[] = ["a", "b"];
    const resolved = (s: Side) =>
      this.pendingReveals.has(s) || this.forfeitedSides.has(s) || this.failedReveals.has(s);
    if (sides.every(resolved)) this.judgeAndAdvance();
  }

  private judgeAndAdvance(): void {
    this.clearPhaseTimer();
    const aReveal = this.pendingReveals.get("a");
    const bReveal = this.pendingReveals.get("b");
    // "In the running" = committed AND not failed reveal AND not forfeited.
    const inRunning = (s: Side) =>
      !this.failedReveals.has(s) &&
      !this.forfeitedSides.has(s) &&
      (this.pendingCommits.has(s) || this.pendingReveals.has(s));
    const aIn = inRunning("a");
    const bIn = inRunning("b");
    let result: RoundResult;
    if (aReveal && bReveal) {
      result = judgeRound(this.roundIndex, aReveal.move, bReveal.move);
    } else if (aIn && !bIn) {
      // a wins forfeit. record their move iff revealed; else null (commit-phase walkover).
      result = judgeForfeit(this.roundIndex, { side: "a", move: aReveal?.move ?? null });
    } else if (bIn && !aIn) {
      result = judgeForfeit(this.roundIndex, { side: "b", move: bReveal?.move ?? null });
    } else {
      result = judgeForfeit(this.roundIndex, null);
    }
    this.rounds.push(result);
    setRounds(this.host.matchId, this.rounds, this.roundIndex + 1);

    // Round result frame: per-player perspective. yourMove/theirMove are null
    // for any side that didn't validly reveal.
    this.host.sendTo("a", {
      type: "round_result",
      ts: this.host.now(),
      round: result.round,
      yourMove: aReveal?.move ?? null,
      theirMove: bReveal?.move ?? null,
      winner: result.winner,
      forfeitedBy: result.forfeitedBy,
    });
    this.host.sendTo("b", {
      type: "round_result",
      ts: this.host.now(),
      round: result.round,
      yourMove: bReveal?.move ?? null,
      theirMove: aReveal?.move ?? null,
      winner: result.winner,
      forfeitedBy: result.forfeitedBy,
    });
    this.log.info({ round: result.round, winner: result.winner }, "round.judged");

    const decision = decideMatch(this.rounds);
    if (!decision.complete) {
      this.roundIndex += 1;
      this.startRound();
      return;
    }
    // Hand the result back to the shell, which broadcasts match_result and
    // drives settlement. winner is non-null when complete is true.
    this.host.onComplete(decision.winner!, this.rounds);
  }

  private handleForfeit(side: Side): void {
    if (!this.host.isActive()) return;
    if (this.forfeitedSides.has(side)) return;
    this.forfeitedSides.add(side);
    this.log.info({ side, round: this.roundIndex }, "round.forfeit");
    // Drop any partial commit/reveal so we don't accidentally count this side
    // as having a move. (A side that already revealed can't un-reveal — they
    // already played fairly; ignore the forfeit_round in that case.)
    if (this.pendingReveals.has(side)) {
      this.forfeitedSides.delete(side);
      return;
    }
    this.pendingCommits.delete(side);
    this.checkRoundCompletion();
  }

  // ───────── commit-reveal ─────────

  private handleCommit(side: Side, round: number, commitHash: string): void {
    if (!this.host.isActive()) {
      this.host.sendError(side, "OUT_OF_ORDER_MOVE", `match not active`, false);
      return;
    }
    if (round !== this.roundIndex) {
      this.host.sendError(
        side,
        "OUT_OF_ORDER_MOVE",
        `expected round ${this.roundIndex}, got ${round}`,
        false,
      );
      return;
    }
    if (this.roundPhase !== "commit") {
      this.host.sendError(side, "OUT_OF_ORDER_MOVE", "commit phase closed for this round", false);
      return;
    }
    if (this.phaseDeadline !== null && this.host.now() > this.phaseDeadline) {
      this.host.sendError(side, "LATE_COMMIT", `commit past deadline for round ${round}`, false);
      return;
    }
    if (this.pendingCommits.has(side)) {
      this.host.sendError(side, "OUT_OF_ORDER_MOVE", "already committed this round", false);
      return;
    }
    this.pendingCommits.set(side, commitHash);
    insertCommit(this.host.matchId, round, side, commitHash);
    this.log.info({ side, round, commit: commitHash.slice(0, 8) }, "commit.received");
    if (this.pendingCommits.size === 2) {
      this.clearPhaseTimer();
      this.startRevealPhase();
    }
  }

  private handleReveal(side: Side, round: number, move: Move, nonce: string): void {
    if (!this.host.isActive()) {
      this.host.sendError(side, "OUT_OF_ORDER_MOVE", `match not active`, false);
      return;
    }
    if (round !== this.roundIndex) {
      this.host.sendError(
        side,
        "OUT_OF_ORDER_MOVE",
        `expected round ${this.roundIndex}, got ${round}`,
        false,
      );
      return;
    }
    if (this.roundPhase !== "reveal") {
      this.host.sendError(side, "OUT_OF_ORDER_MOVE", "not in reveal phase yet", false);
      return;
    }
    if (this.phaseDeadline !== null && this.host.now() > this.phaseDeadline) {
      this.host.sendError(side, "LATE_REVEAL", `reveal past deadline for round ${round}`, false);
      return;
    }
    const expected = this.pendingCommits.get(side);
    if (!expected) {
      this.host.sendError(side, "OUT_OF_ORDER_MOVE", "no commit on file for this round", false);
      return;
    }
    if (this.pendingReveals.has(side) || this.failedReveals.has(side)) {
      this.host.sendError(side, "OUT_OF_ORDER_MOVE", "already revealed this round", false);
      return;
    }
    if (!verifyCommit(move, nonce, expected)) {
      // Hash mismatch. Treat as a round-level forfeit by this side (the other
      // side wins the round). We don't fail the match — could be a buggy
      // client. The DB row keeps the commit hash so the cheat is auditable.
      this.failedReveals.add(side);
      this.log.warn({ side, round, expected: expected.slice(0, 8) }, "reveal.bad_hash");
      this.host.sendError(side, "BAD_REVEAL", "reveal does not match committed hash", false);
      this.checkRoundCompletion();
      return;
    }
    this.pendingReveals.set(side, { move, nonce });
    recordReveal(this.host.matchId, round, side, move, nonce);
    this.log.info({ side, round, move }, "reveal.received");
    this.checkRoundCompletion();
  }

  // ───────── reconnect ─────────

  resync(side: Side): void {
    // If a soft WS reconnect drops in mid-reveal-phase, the client missed the
    // commits_locked frame and won't fire its reveal. Re-send it. (A hard
    // refresh wipes the secret in memory either way and the round forfeits on
    // the reveal deadline.)
    if (!this.host.isActive() || this.roundPhase !== "reveal" || this.phaseDeadline === null) return;
    const aHash = this.pendingCommits.get("a");
    const bHash = this.pendingCommits.get("b");
    if (!aHash || !bHash) return;
    this.host.sendTo(side, {
      type: "commits_locked",
      ts: this.host.now(),
      round: this.roundIndex,
      deadline: this.phaseDeadline,
      commits: { a: aHash, b: bHash },
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.clearPhaseTimer();
  }
}
