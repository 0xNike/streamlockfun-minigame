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
  setSessionPda,
  setSessionState,
  setPlayerB,
  setWinner,
  setWagerSnapshot,
  setFailed,
  signaturesForSession,
} from "./db.js";
import { logger } from "./log.js";
import * as lobby from "./lobby.js";
import type { GameEngine, GameHost } from "./games/engine.js";
import { DEFAULT_GAME_ID, getGame } from "./games/registry.js";
import * as settlement from "./settlement.js";
import {
  ClientFrame,
  type ErrorCode,
  type MatchSnapshot,
  type MatchState,
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
  winner: Side | "tie" | null = null;
  failedReason: string | null = null;
  /** Amount-based wager. Populated at B-join via materialiseWager(). Null until then,
   *  and null on legacy/pre-migration matches that fall back to symmetric bpsAtStake. */
  wager: WagerSnapshot | null = null;
  /** Creator's desired wager amount (decimal u64 string), if supplied at create.
   *  Acts as an upper bound at B-join; otherwise stakeBps drives the math. */
  desiredWagerAmountRaw: string | null = null;

  /** Gameplay engine for this match's game (commit-reveal RPS today). The shell
   *  owns matchmaking, the on-chain session, settlement, sockets and snapshots;
   *  the engine owns play between "active" and a winner, which it reports back
   *  via the GameHost built in the constructor. */
  private readonly engine: GameEngine;
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
    /** Which game this match plays; looked up in the game registry to build the
     *  engine. In-memory only today (see registry.ts). */
    public readonly gameId: string = DEFAULT_GAME_ID,
  ) {
    this.state = playerB ? "creating" : "partnered";
    const host: GameHost = {
      matchId: this.id,
      log: this.log,
      now: () => nowSec(),
      isActive: () => this.state === "active" && !this.destroyed,
      broadcast: (f) => this.broadcast(f),
      sendTo: (side, f) => this.sendTo(side, f),
      sendError: (side, code, message, fatal) => this.sendError(side, code, message, fatal),
      socketFor: (side) => (side === "a" ? this.playerA : this.playerB)?.socket ?? null,
      onComplete: (winner, rounds) => this.onMatchComplete(winner, rounds),
    };
    this.engine = getGame(this.gameId).createEngine(host);
  }

  private get log() {
    return logger.child({ matchId: this.id });
  }

  /** A match is mirrored to the Games Lobby only when its wager is fixed at
   *  create time (Phase 1 decision). Drives the best-effort lobby.* updates. */
  private get lobbyEligible(): boolean {
    return !!this.desiredWagerAmountRaw;
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
    if (this.lobbyEligible) void lobby.updateListing(this.id, { playersJoined: 2 });
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
      if (this.lobbyEligible)
        void lobby.updateListing(this.id, {
          status: "InProgress",
          gameSessionPda: pda,
          // Push the TTL out so an in-progress match isn't dropped from the
          // lobby mid-game (the create-time TTL is sized for unfilled offers).
          expiresAt: nowSec() + 3600,
        });
      this.transition("active", "session_created");
      this.engine.start();
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err), "create_failed");
    }
  }

  /** Engine callback: gameplay resolved. Broadcast the result, then settle. */
  private onMatchComplete(winner: Side | "tie", rounds: RoundResult[]): void {
    this.winner = winner;
    this.broadcast({ type: "match_result", ts: nowSec(), winner, rounds });
    this.transition("complete", "best_of_three_done");
    void this.runSettlement();
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
        if (this.lobbyEligible) void lobby.closeListing(this.id, "Cancelled");
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
    if (this.lobbyEligible) void lobby.updateListing(this.id, { status: "Settling" });
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
      if (this.lobbyEligible) void lobby.closeListing(this.id, "Finalized");
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
    if (this.lobbyEligible) void lobby.closeListing(this.id, "Cancelled");
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
    this.engine.destroy();
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
        rounds: this.engine.progress().rounds,
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
    // If a soft WS reconnect drops in mid-game, the client may have missed
    // phase state (e.g. RPS's commits_locked). Let the engine re-push it. (A
    // hard refresh wipes any in-memory secret either way.)
    this.engine.resync(side);
    this.broadcast({ type: "peer_status", ts: nowSec(), peer: side, connected: true });
    this.log.info({ side }, "match.attach");
    return true;
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
          this.engine.resync(side);
        }
        return;
      }
      case "leave": {
        const sk = this.slot(side).socket;
        this.detachSocket(side, 1000, "voluntary leave");
        sk?.close(1000, "voluntary leave");
        return;
      }
      default:
        // Gameplay frames (commit / reveal / forfeit_round): the engine owns them.
        this.engine.handleFrame(side, frame);
        return;
    }
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
    const progress = this.engine.progress();
    return {
      matchId: this.id,
      gameId: this.gameId,
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
      roundIndex: progress.roundIndex,
      rounds: progress.rounds,
      gameState: progress.state ?? null,
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
  /** Which game to play. Defaults to RPS. */
  gameId?: string;
}): LiveMatch {
  const gameId = args.gameId ?? DEFAULT_GAME_ID;
  getGame(gameId); // validate before we touch the DB — throws on unknown id
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
    gameId,
  );
  match.desiredWagerAmountRaw = args.desiredWagerAmountRaw ?? null;
  registry.set(id, match);
  // Mirror to the Games Lobby from create time — but only when the wager is
  // fixed up front (Phase 1 decision). Best-effort; never blocks match creation.
  if (args.desiredWagerAmountRaw) {
    void lobby.createListing({
      matchId: id,
      gameId: args.gameId ?? DEFAULT_GAME_ID,
      tokenMint: args.tokenMint,
      wagerAmountRaw: args.desiredWagerAmountRaw,
    });
  }
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
