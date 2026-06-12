/**
 * Live match registry + per-match state machine.
 *
 *   create → partnered → creating → active → complete → submitting → dispute_wait
 *                                                                    → finalizing → applying → done
 *                                                  → cancelling → cancelled
 *                                                              → failed
 *
 * One process holds one Map<matchId, LiveMatch>. Matches that crash mid-flight
 * are handled by reconciler.ts at startup (Phase 3 handles settlement-stage
 * recovery; Phase 1 just marks pre-settlement matches failed and moves on).
 */

import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import type { DeltaEntry } from "@streamlock/operator-sdk";
import { op } from "../operator.js";
import { config } from "./config.js";
import { getTokenMeta, peekTokenMeta } from "./tokenmeta.js";
import {
  insertSession,
  insertCommit,
  recordReveal,
  setSessionPda,
  setSessionState,
  setPlayerB,
  setRounds,
  setWinner,
  setWagerSnapshot,
  setFailed,
  signaturesForSession,
} from "./db.js";
import { logger } from "./log.js";
import { decideMatch, judgeForfeit, judgeRound, verifyCommit } from "./rps.js";
import * as settlement from "./settlement.js";
import {
  ClientFrame,
  type ErrorCode,
  type MatchSnapshot,
  type MatchState,
  type Move,
  type RoundResult,
  type ServerFrame,
  type Side,
  TERMINAL_STATES,
} from "./types.js";
import { loserBpsFromSnapshot, type WagerSnapshot } from "./wager.js";

const nowSec = () => Math.floor(Date.now() / 1000);

/** Small retry helper — exponential backoff, 3 attempts. Surfaces last error. */
async function retry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 250): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

interface PlayerSlot {
  wallet: string;
  streamId: string;
  socket: WebSocket | null;
  graceTimer: NodeJS.Timeout | null;
  effectiveBps: number | null;
  entitledLamports: string | null;
  lockedTokenAmount: string | null;
}

// ───────── LiveMatch ─────────

export class LiveMatch {
  state: MatchState;
  pda: string | null = null;
  endTs: number | null = null;
  roundIndex = 0;
  rounds: RoundResult[] = [];
  winner: Side | "tie" | null = null;
  failedReason: string | null = null;
  /** Amount-based wager. Populated at B-join via materialiseWager(). Null until then,
   *  and null on legacy/pre-migration matches that fall back to symmetric bpsAtStake. */
  wager: WagerSnapshot | null = null;
  /** Creator's desired wager amount (decimal u64 string), if supplied at create.
   *  Acts as an upper bound at B-join; otherwise stakeBps drives the math. */
  desiredWagerAmountRaw: string | null = null;

  // Round flow: commit phase → reveal phase → judge.
  //
  //   pendingCommits — sha256(move:nonce) seen so far, by side.
  //   pendingReveals — verified (move, nonce) pairs, by side.
  //   failedReveals  — sides whose reveal hash didn't match their commit. Treated
  //                    the same as a forfeit for resolution purposes; persisted
  //                    only in-memory (the audit trail is in the DB row's
  //                    commit_hash + missing reveal columns).
  //   forfeitedSides — sides that explicitly sent `forfeit_round`.
  //
  // A side is "in the running" for the round iff they committed AND are not in
  // failedReveals or forfeitedSides. Only validly-revealed moves count as plays.
  private pendingCommits: Map<Side, string> = new Map();
  private pendingReveals: Map<Side, { move: Move; nonce: string }> = new Map();
  private failedReveals: Set<Side> = new Set();
  private forfeitedSides: Set<Side> = new Set();
  private roundPhase: "commit" | "reveal" = "commit";
  private phaseDeadline: number | null = null;
  private phaseTimer: NodeJS.Timeout | null = null;
  private destroyed = false;

  constructor(
    public readonly id: string,
    public readonly tokenMint: string,
    public readonly disputeWindowSec: number,
    public readonly bpsAtStake: number,
    public readonly playerA: PlayerSlot,
    public playerB: PlayerSlot | null,
    /** When true, joiners must present a valid wid_session cookie matching their wallet. */
    public readonly verifiedOnly: boolean = false,
    /** Creator's World ID nullifier when verifiedOnly. Used at join time to
     *  reject the same-human-as-opponent case. Null on open matches. */
    public readonly creatorNullifier: string | null = null,
  ) {
    this.state = playerB ? "creating" : "partnered";
  }

  private get log() {
    return logger.child({ matchId: this.id });
  }

  private slot(side: Side): PlayerSlot {
    if (side === "a") return this.playerA;
    if (!this.playerB) throw new Error("playerB not set");
    return this.playerB;
  }

  // ───────── lifecycle ─────────

  hasSlotForB(): boolean {
    return !this.playerB;
  }

  joinAsB(wallet: string, streamId: string, wager: WagerSnapshot | null): void {
    if (this.playerB) throw new Error("MATCH_FULL");
    if (wallet === this.playerA.wallet) throw new Error("CANNOT_SELF_MATCH");
    this.playerB = {
      wallet,
      streamId,
      socket: null,
      graceTimer: null,
      effectiveBps: null,
      entitledLamports: null,
      // Pre-fill from the snapshot so the first hello-snapshot already shows
      // the agreed-on wager; refreshEntitlements will overwrite with a live read.
      lockedTokenAmount: wager?.lockedAtMatchTime.b ?? null,
    };
    if (wager) {
      // Pre-fill A's locked from the same snapshot for symmetry / first-render.
      this.playerA.lockedTokenAmount = wager.lockedAtMatchTime.a;
      this.wager = wager;
      setWagerSnapshot(this.id, {
        amountRaw: wager.amountRaw,
        lockedA: wager.lockedAtMatchTime.a,
        lockedB: wager.lockedAtMatchTime.b,
        bpsIfALoses: wager.bpsIfALoses,
        bpsIfBLoses: wager.bpsIfBLoses,
      });
    }
    setPlayerB(this.id, wallet, streamId, "creating");
    this.transition("creating", "b_joined");
    void this.refreshEntitlements();
    void this.runOnChainCreate();
  }

  private async refreshEntitlements(): Promise<void> {
    // One token-streams call to grab lockedTokenAmount per streamId; the
    // entitlement() endpoint is per-holder and doesn't expose it (until SDK 0.1.5
    // ships the merge). Per-mint cardinality is small enough that this is fine.
    const lockedByStream = new Map<string, string | null>();
    try {
      const { streams } = (await retry(() => op.tokens.streams(this.tokenMint))) as {
        streams: Array<{ streamId: string; lockedTokenAmount?: string | null }>;
      };
      for (const s of streams) lockedByStream.set(s.streamId, s.lockedTokenAmount ?? null);
    } catch (err) {
      this.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "tokens_streams.fetch_failed",
      );
    }

    // Each side's current effectiveBps for UI display. Retried a few times so a
    // transient SDK miss doesn't strand the UI on a "—" placeholder for the
    // entire match.
    const fetchOne = async (slot: PlayerSlot) => {
      try {
        const ent = (await retry(() =>
          op.streams.entitlement(slot.streamId, slot.wallet),
        )) as { effectiveBps?: number; entitledLamports?: string };
        slot.effectiveBps = ent.effectiveBps ?? slot.effectiveBps;
        slot.entitledLamports = ent.entitledLamports ?? slot.entitledLamports;
      } catch (err) {
        this.log.warn(
          { err: err instanceof Error ? err.message : String(err), streamId: slot.streamId },
          "entitlement.fetch_failed",
        );
      }
      slot.lockedTokenAmount = lockedByStream.get(slot.streamId) ?? slot.lockedTokenAmount;
    };
    await Promise.all([
      fetchOne(this.playerA),
      this.playerB ? fetchOne(this.playerB) : Promise.resolve(),
    ]);
    // Push snapshot to clients so they see the updated bps without waiting for next state change.
    this.broadcast({ type: "state", ts: nowSec(), state: this.state, reason: "entitlements_loaded" });
  }

  private async runOnChainCreate(): Promise<void> {
    if (!this.playerB) throw new Error("playerB missing");
    try {
      const { pda, endTs } = await settlement.createSession({
        sessionId: this.id,
        tokenMint: this.tokenMint,
        playerA: { wallet: this.playerA.wallet, streamId: this.playerA.streamId },
        playerB: { wallet: this.playerB.wallet, streamId: this.playerB.streamId },
        endTsBufferSec: config.ENDTS_BUFFER_SEC,
        disputeWindowSec: this.disputeWindowSec,
        broadcast: (f) => this.broadcast(f),
      });
      this.pda = pda;
      this.endTs = endTs;
      setSessionPda(this.id, pda, endTs);
      this.transition("active", "session_created");
      this.startRound();
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err), "create_failed");
    }
  }

  private startRound(): void {
    if (this.destroyed || this.state !== "active") return;
    this.pendingCommits.clear();
    this.pendingReveals.clear();
    this.failedReveals.clear();
    this.forfeitedSides.clear();
    this.roundPhase = "commit";
    const deadline = nowSec() + config.ROUND_DEADLINE_SEC;
    this.phaseDeadline = deadline;
    this.broadcast({ type: "round_start", ts: nowSec(), round: this.roundIndex, deadline });
    this.log.info({ round: this.roundIndex, phase: "commit", deadline }, "round.start");
    this.armPhaseTimer(config.ROUND_DEADLINE_SEC);
  }

  private startRevealPhase(): void {
    if (this.destroyed || this.state !== "active") return;
    this.roundPhase = "reveal";
    const deadline = nowSec() + config.REVEAL_DEADLINE_SEC;
    this.phaseDeadline = deadline;
    const aHash = this.pendingCommits.get("a");
    const bHash = this.pendingCommits.get("b");
    if (!aHash || !bHash) {
      // Defensive: only call this once both commits are in.
      this.log.error({ aHash: !!aHash, bHash: !!bHash }, "reveal_phase.missing_commit");
      return;
    }
    this.broadcast({
      type: "commits_locked",
      ts: nowSec(),
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
    if (this.state !== "active") return;
    this.log.warn(
      { round: this.roundIndex, phase: this.roundPhase },
      "phase.deadline_hit",
    );
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
      this.pendingReveals.has(s) ||
      this.forfeitedSides.has(s) ||
      this.failedReveals.has(s);
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
    setRounds(this.id, this.rounds, this.roundIndex + 1);

    // Round result frame: per-player perspective. yourMove/theirMove are null
    // for any side that didn't validly reveal.
    this.sendTo("a", {
      type: "round_result",
      ts: nowSec(),
      round: result.round,
      yourMove: aReveal?.move ?? null,
      theirMove: bReveal?.move ?? null,
      winner: result.winner,
      forfeitedBy: result.forfeitedBy,
    });
    this.sendTo("b", {
      type: "round_result",
      ts: nowSec(),
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
    this.winner = decision.winner;
    this.broadcast({
      type: "match_result",
      ts: nowSec(),
      winner: this.winner!,
      rounds: this.rounds,
    });
    this.transition("complete", "best_of_three_done");
    void this.runSettlement();
  }

  private handleForfeit(side: Side): void {
    if (this.state !== "active") return;
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

  private async runSettlement(): Promise<void> {
    if (this.winner === "tie") {
      this.transition("cancelling", "tie_match");
      try {
        if (this.pda) {
          await settlement.cancelSession({
            sessionId: this.id,
            pda: this.pda,
            broadcast: (f) => this.broadcast(f),
          });
        }
        this.transition("cancelled", "tie");
        this.broadcast({ type: "cancelled", ts: nowSec(), reason: "tie" });
      } catch (err) {
        this.fail(err instanceof Error ? err.message : String(err), "cancel_failed");
      }
      this.cleanup();
      return;
    }
    if (this.winner !== "a" && this.winner !== "b") return;

    const winnerSlot = this.winner === "a" ? this.playerA : this.playerB!;
    const loserSlot = this.winner === "a" ? this.playerB! : this.playerA;

    // Pick the bps for this exact outcome. When an amount-based wager snapshot
    // is set (the new path), use its precomputed per-outcome bps so settlement
    // never re-derives from drifted live data. When null (legacy / locked
    // missing), fall back to the symmetric bpsAtStake intent.
    const settleBps = this.wager
      ? loserBpsFromSnapshot(this.wager, this.winner)
      : this.bpsAtStake;
    const deltas: DeltaEntry[] = [
      {
        player: loserSlot.wallet,
        streamId: loserSlot.streamId,
        deltaBps: -settleBps,
      },
      {
        player: winnerSlot.wallet,
        streamId: loserSlot.streamId, // bps moves WITHIN loser's stream
        deltaBps: +settleBps,
      },
    ];
    setWinner(this.id, this.winner, deltas, "submitting");
    this.transition("submitting", "deltas_built");
    if (!this.pda) {
      this.fail("missing pda at submit time", "no_pda");
      return;
    }

    try {
      await settlement.submitDeltas({
        sessionId: this.id,
        pda: this.pda,
        deltas,
        broadcast: (f) => this.broadcast(f),
      });
      this.transition("dispute_wait", "submitted");
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err), "submit_failed");
      return;
    }

    // Wait until chain time has cleared endTs + disputeWindowSec + buffer.
    const eligibleAt = (this.endTs ?? nowSec()) + this.disputeWindowSec + config.FINALIZE_BUFFER_SEC;
    const waitMs = Math.max(0, (eligibleAt - nowSec()) * 1000);
    this.log.info({ eligibleAt, waitMs }, "dispute.wait");
    await new Promise<void>((r) => setTimeout(r, waitMs));
    if (this.destroyed) return;

    this.transition("finalizing", "window_elapsed");
    try {
      const { finalizeSigs, applySigs } = await settlement.finalizeAndApply({
        sessionId: this.id,
        pda: this.pda,
        deltas,
        broadcast: (f) => this.broadcast(f),
      });
      this.transition("applying", "finalize_done");
      // applySigs already broadcast as confirmed via runChainOp.
      this.transition("done", "apply_done");
      const cluster = config.TOKEN_ENV === "sol" ? "mainnet" : "devnet";
      this.broadcast({
        type: "done",
        ts: nowSec(),
        winner: this.winner!,
        finalSignatures: signaturesForSession(this.id),
        explorerLinks: signaturesForSession(this.id).map(
          (s) => `https://solscan.io/tx/${s.sig}?cluster=${cluster}`,
        ),
      });
      this.log.info({ finalizeSigs, applySigs }, "match.done");
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err), "finalize_failed");
    }
    this.cleanup();
  }

  private fail(message: string, code: string): void {
    this.failedReason = `${code}: ${message}`;
    setFailed(this.id, "failed", this.failedReason);
    this.state = "failed";
    this.log.error({ code, message }, "match.failed");
    this.broadcast({
      type: "failed",
      ts: nowSec(),
      reason: this.failedReason,
      contact: "operator",
    });
    this.cleanup();
  }

  private cleanup(): void {
    this.destroyed = true;
    this.clearPhaseTimer();
    if (this.playerA.graceTimer) clearTimeout(this.playerA.graceTimer);
    if (this.playerB?.graceTimer) clearTimeout(this.playerB.graceTimer);
  }

  private handleAbandon(side: Side): void {
    if (TERMINAL_STATES.has(this.state)) return;
    this.log.warn({ side }, "match.abandon_grace_expired");
    if (this.state === "partnered" || this.state === "creating") {
      // No on-chain create yet, or create may or may not have landed; for simplicity we mark failed.
      this.fail(`player ${side} abandoned before play started`, "pre_play_abandon");
      return;
    }
    if (this.state === "active") {
      // Abandoned mid-play. Forfeit all remaining rounds to other side.
      const winner: Side = side === "a" ? "b" : "a";
      this.winner = winner;
      this.broadcast({
        type: "match_result",
        ts: nowSec(),
        winner,
        rounds: this.rounds,
      });
      this.transition("complete", "abandon_forfeit");
      void this.runSettlement();
    }
  }

  // ───────── socket plumbing ─────────

  attachSocket(side: Side, socket: WebSocket): boolean {
    if (side === "b" && !this.playerB) {
      this.sendErrorAndClose(socket, "MATCH_NOT_FOUND", "no playerB slot configured", 1008);
      return false;
    }
    const slot = this.slot(side);
    if (slot.socket && slot.socket.readyState === WebSocket.OPEN) {
      this.sendErrorAndClose(socket, "SLOT_TAKEN", "slot already connected", 1008);
      return false;
    }
    slot.socket = socket;
    if (slot.graceTimer) {
      clearTimeout(slot.graceTimer);
      slot.graceTimer = null;
    }
    socket.send(
      JSON.stringify({
        type: "hello",
        ts: nowSec(),
        matchId: this.id,
        you: side,
        snapshot: this.snapshot(),
      } satisfies ServerFrame),
    );
    // If a soft WS reconnect drops in mid-reveal-phase, the client missed the
    // commits_locked frame and won't fire its reveal. Re-send it. (A hard
    // refresh wipes the secret in memory either way and the round will
    // forfeit on the reveal deadline.)
    this.maybeResendCommitsLocked(socket);
    this.broadcast({ type: "peer_status", ts: nowSec(), peer: side, connected: true });
    this.log.info({ side }, "match.attach");
    return true;
  }

  private maybeResendCommitsLocked(socket: WebSocket): void {
    if (
      this.state !== "active" ||
      this.roundPhase !== "reveal" ||
      this.phaseDeadline === null
    )
      return;
    const aHash = this.pendingCommits.get("a");
    const bHash = this.pendingCommits.get("b");
    if (!aHash || !bHash) return;
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({
        type: "commits_locked",
        ts: nowSec(),
        round: this.roundIndex,
        deadline: this.phaseDeadline,
        commits: { a: aHash, b: bHash },
      } satisfies ServerFrame),
    );
  }

  detachSocket(side: Side, code: number, reason: string): void {
    const slot = this.slot(side);
    slot.socket = null;
    this.log.info({ side, code, reason }, "match.detach");
    if (TERMINAL_STATES.has(this.state)) return;
    if (this.state === "partnered" || this.state === "creating" || this.state === "active") {
      const graceUntil = nowSec() + config.RECONNECT_GRACE_SEC;
      this.broadcast({
        type: "peer_status",
        ts: nowSec(),
        peer: side,
        connected: false,
        graceUntil,
      });
      slot.graceTimer = setTimeout(
        () => this.handleAbandon(side),
        config.RECONNECT_GRACE_SEC * 1000,
      );
    }
  }

  receiveFrame(side: Side, raw: unknown): void {
    const parsed = ClientFrame.safeParse(raw);
    if (!parsed.success) {
      this.sendError(side, "BAD_FRAME", parsed.error.errors[0]?.message ?? "invalid frame", false);
      return;
    }
    const frame = parsed.data;
    switch (frame.type) {
      case "pong":
        return;
      case "request_resync": {
        const slot = this.slot(side);
        if (slot.socket?.readyState === WebSocket.OPEN) {
          slot.socket.send(
            JSON.stringify({
              type: "hello",
              ts: nowSec(),
              matchId: this.id,
              you: side,
              snapshot: this.snapshot(),
            } satisfies ServerFrame),
          );
          this.maybeResendCommitsLocked(slot.socket);
        }
        return;
      }
      case "leave": {
        const sk = this.slot(side).socket;
        this.detachSocket(side, 1000, "voluntary leave");
        sk?.close(1000, "voluntary leave");
        return;
      }
      case "forfeit_round":
        if (this.state !== "active") {
          this.sendError(side, "OUT_OF_ORDER_MOVE", `match not active`, false);
          return;
        }
        if (frame.round !== this.roundIndex) {
          this.sendError(
            side,
            "OUT_OF_ORDER_MOVE",
            `expected round ${this.roundIndex}`,
            false,
          );
          return;
        }
        this.handleForfeit(side);
        return;
      case "commit":
        this.handleCommit(side, frame.round, frame.commitHash);
        return;
      case "reveal":
        this.handleReveal(side, frame.round, frame.move, frame.nonce);
        return;
    }
  }

  // ───────── commit-reveal ─────────

  private handleCommit(side: Side, round: number, commitHash: string): void {
    if (this.state !== "active") {
      this.sendError(side, "OUT_OF_ORDER_MOVE", `match not active (${this.state})`, false);
      return;
    }
    if (round !== this.roundIndex) {
      this.sendError(
        side,
        "OUT_OF_ORDER_MOVE",
        `expected round ${this.roundIndex}, got ${round}`,
        false,
      );
      return;
    }
    if (this.roundPhase !== "commit") {
      this.sendError(side, "OUT_OF_ORDER_MOVE", "commit phase closed for this round", false);
      return;
    }
    if (this.phaseDeadline !== null && nowSec() > this.phaseDeadline) {
      this.sendError(side, "LATE_COMMIT", `commit past deadline for round ${round}`, false);
      return;
    }
    if (this.pendingCommits.has(side)) {
      this.sendError(side, "OUT_OF_ORDER_MOVE", "already committed this round", false);
      return;
    }
    this.pendingCommits.set(side, commitHash);
    insertCommit(this.id, round, side, commitHash);
    this.log.info(
      { side, round, commit: commitHash.slice(0, 8) },
      "commit.received",
    );
    if (this.pendingCommits.size === 2) {
      this.clearPhaseTimer();
      this.startRevealPhase();
    }
  }

  private handleReveal(side: Side, round: number, move: Move, nonce: string): void {
    if (this.state !== "active") {
      this.sendError(side, "OUT_OF_ORDER_MOVE", `match not active (${this.state})`, false);
      return;
    }
    if (round !== this.roundIndex) {
      this.sendError(
        side,
        "OUT_OF_ORDER_MOVE",
        `expected round ${this.roundIndex}, got ${round}`,
        false,
      );
      return;
    }
    if (this.roundPhase !== "reveal") {
      this.sendError(side, "OUT_OF_ORDER_MOVE", "not in reveal phase yet", false);
      return;
    }
    if (this.phaseDeadline !== null && nowSec() > this.phaseDeadline) {
      this.sendError(side, "LATE_REVEAL", `reveal past deadline for round ${round}`, false);
      return;
    }
    const expected = this.pendingCommits.get(side);
    if (!expected) {
      this.sendError(side, "OUT_OF_ORDER_MOVE", "no commit on file for this round", false);
      return;
    }
    if (this.pendingReveals.has(side) || this.failedReveals.has(side)) {
      this.sendError(side, "OUT_OF_ORDER_MOVE", "already revealed this round", false);
      return;
    }
    if (!verifyCommit(move, nonce, expected)) {
      // Hash mismatch. Treat as a round-level forfeit by this side (the other
      // side wins the round). We don't fail the match — could be a buggy
      // client. The DB row keeps the commit hash so the cheat is auditable.
      this.failedReveals.add(side);
      this.log.warn(
        { side, round, expected: expected.slice(0, 8) },
        "reveal.bad_hash",
      );
      this.sendError(side, "BAD_REVEAL", "reveal does not match committed hash", false);
      this.checkRoundCompletion();
      return;
    }
    this.pendingReveals.set(side, { move, nonce });
    recordReveal(this.id, round, side, move, nonce);
    this.log.info({ side, round, move }, "reveal.received");
    this.checkRoundCompletion();
  }

  // ───────── frame helpers ─────────

  broadcast(frame: ServerFrame): void {
    for (const slot of [this.playerA, this.playerB]) {
      if (!slot) continue;
      const sk = slot.socket;
      if (sk && sk.readyState === WebSocket.OPEN) {
        sk.send(JSON.stringify(frame));
      }
    }
  }

  sendTo(side: Side, frame: ServerFrame): void {
    const sk = this.slot(side).socket;
    if (sk && sk.readyState === WebSocket.OPEN) sk.send(JSON.stringify(frame));
  }

  private sendError(side: Side, code: ErrorCode, message: string, fatal: boolean): void {
    this.sendTo(side, { type: "error", ts: nowSec(), code, message, fatal });
  }

  private sendErrorAndClose(
    socket: WebSocket,
    code: ErrorCode,
    message: string,
    closeCode: number,
  ): void {
    socket.send(
      JSON.stringify({ type: "error", ts: nowSec(), code, message, fatal: true } satisfies ServerFrame),
    );
    socket.close(closeCode, code);
  }

  // ───────── snapshot for hello / GET endpoint ─────────

  snapshot(): MatchSnapshot {
    return {
      matchId: this.id,
      state: this.state,
      pda: this.pda,
      tokenMint: this.tokenMint,
      tokenMeta: peekTokenMeta(this.tokenMint),
      playerA: {
        wallet: this.playerA.wallet,
        streamId: this.playerA.streamId,
        connected: !!this.playerA.socket && this.playerA.socket.readyState === WebSocket.OPEN,
        effectiveBps: this.playerA.effectiveBps,
        entitledLamports: this.playerA.entitledLamports,
        lockedTokenAmount: this.playerA.lockedTokenAmount,
      },
      playerB: this.playerB
        ? {
            wallet: this.playerB.wallet,
            streamId: this.playerB.streamId,
            connected:
              !!this.playerB.socket && this.playerB.socket.readyState === WebSocket.OPEN,
            effectiveBps: this.playerB.effectiveBps,
            entitledLamports: this.playerB.entitledLamports,
            lockedTokenAmount: this.playerB.lockedTokenAmount,
          }
        : null,
      roundIndex: this.roundIndex,
      rounds: this.rounds,
      winner: this.winner,
      endTs: this.endTs,
      disputeWindowSec: this.disputeWindowSec,
      finalizeEligibleAt: this.endTs ? this.endTs + this.disputeWindowSec : null,
      bpsAtStake: this.bpsAtStake,
      wager: this.wager,
      verifiedOnly: this.verifiedOnly,
      signatures: signaturesForSession(this.id),
      failedReason: this.failedReason,
    };
  }

  // ───────── transitions ─────────

  private transition(next: MatchState, reason: string): void {
    const prev = this.state;
    this.state = next;
    setSessionState(this.id, next);
    this.log.info({ prev, next, reason }, "state.transition");
    this.broadcast({ type: "state", ts: nowSec(), state: next, reason });
  }
}

// ───────── registry ─────────

const registry = new Map<string, LiveMatch>();

export function getLive(id: string): LiveMatch | undefined {
  return registry.get(id);
}

export function listLive(): LiveMatch[] {
  return [...registry.values()];
}

export function deregister(id: string): void {
  registry.delete(id);
}

export function createLiveMatch(args: {
  tokenMint: string;
  playerAWallet: string;
  playerAStream: string;
  bpsAtStake: number;
  disputeWindowSec: number;
  /** Optional amount the creator wants to wager. Used as an upper bound at
   *  B-join (clamped down to min(lockedA, lockedB)). When omitted, B-join
   *  derives amount from `bpsAtStake × min(lockedA, lockedB) / 10000`. */
  desiredWagerAmountRaw?: string;
  /** When true, joiners must verify with World ID before joining. */
  verifiedOnly?: boolean;
  /** Creator's World ID nullifier (only meaningful when verifiedOnly). */
  creatorNullifier?: string | null;
}): LiveMatch {
  const id = randomBytes(32).toString("hex"); // sessionIdHex doubles as matchId
  insertSession({
    id,
    state: "partnered",
    tokenMint: args.tokenMint,
    playerAWallet: args.playerAWallet,
    playerAStream: args.playerAStream,
    disputeWindowSec: args.disputeWindowSec,
    bpsAtStake: args.bpsAtStake,
  });
  const match = new LiveMatch(
    id,
    args.tokenMint,
    args.disputeWindowSec,
    args.bpsAtStake,
    {
      wallet: args.playerAWallet,
      streamId: args.playerAStream,
      socket: null,
      graceTimer: null,
      effectiveBps: null,
      entitledLamports: null,
      lockedTokenAmount: null,
    },
    null,
    args.verifiedOnly ?? false,
    args.creatorNullifier ?? null,
  );
  match.desiredWagerAmountRaw = args.desiredWagerAmountRaw ?? null;
  registry.set(id, match);
  // Eager fetch A's entitlement + token metadata so first snapshot has both.
  void match["refreshEntitlements"]();
  void getTokenMeta(args.tokenMint).then(() => {
    // Push a state frame so connected clients pick up freshly-cached metadata.
    match.broadcast({
      type: "state",
      ts: Math.floor(Date.now() / 1000),
      state: match.state,
      reason: "tokenmeta_loaded",
    });
  });
  logger.info(
    { matchId: id, tokenMint: args.tokenMint.slice(0, 8), wallet: args.playerAWallet.slice(0, 8) },
    "match.created",
  );
  return match;
}
