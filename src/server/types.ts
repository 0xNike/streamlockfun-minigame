/**
 * Shared types for the operator server.
 *
 * These define the wire contract between the frontend and this server. Changes
 * here are breaking changes for the frontend; bump a contract version when
 * altering anything on a public path.
 */

import { z } from "zod";

// ───────── Match state machine ─────────

export const MATCH_STATES = [
  "queued",
  "partnered",
  "creating",
  "active",
  "complete",
  "submitting",
  "dispute_wait",
  "finalizing",
  "applying",
  "done",
  "cancelling",
  "cancelled",
  "failed",
] as const;
export type MatchState = (typeof MATCH_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<MatchState> = new Set([
  "done",
  "cancelled",
  "failed",
]);

// ───────── Game primitives ─────────

export const MOVES = ["rock", "paper", "scissors"] as const;
export type Move = (typeof MOVES)[number];

export type Side = "a" | "b";

export type RoundResult = {
  round: number;
  a: Move | null; // null when that side forfeited the round
  b: Move | null;
  winner: Side | "tie";
  forfeitedBy?: Side | "both";
};

export type TxKind = "create" | "submit" | "finalize" | "apply" | "cancel";

// ───────── Session shape mirroring streamlockfun backend ─────────
// Local mirror until @streamlock/operator-sdk exports a typed SessionState.
// Swap to SDK type when v0.1.2 lands; keep the field set aligned.

export type SessionState = {
  sessionPda: string;
  tokenMint: string;
  operator: string;
  participants: { wallet: string; streamId: string }[];
  endTs: number;
  disputeWindowSec: number;
  disputeWindowEndTs: number;
  status: "open" | "finalized" | "cancelled" | "disputed" | string;
  totalChunks: number;
  appliedChunks: number[];
  totalDeltas: number;
  disputeCount: number;
  finalizedAt: string | null;
  createdAt: string;
};

// ───────── HTTP API ─────────

export const CreateMatchBody = z.object({
  wallet: z.string().min(32).max(64),
  streamId: z.string().min(32).max(64),
  tokenMint: z.string().min(32).max(64).optional(),
  // stakeBps is the "intent" — used for display and as the derivation source
  // for amountRaw if the caller didn't pass one. Both null → server fills from
  // config.STAKE_BPS.
  bpsAtStake: z.number().int().positive().max(10000).optional(),
  // Caller may supply an absolute wager amount (BigInt-safe decimal string).
  // If omitted, the server derives it at B-join from `bpsAtStake × min(locked)
  // / 10000`. Validated at join time, never at create.
  wagerAmountRaw: z.string().regex(/^\d+$/, "wagerAmountRaw must be a u64 decimal").optional(),
  // Per-match World ID gate. When true, both creator and joiner must present a
  // valid wid_session cookie matching their wallet. When false (default), the
  // match is open to anyone — same UX as before World ID was introduced.
  verifiedOnly: z.boolean().optional().default(false),
  // Which game to create. Defaults to RPS server-side; validated against the
  // game registry when set. Kept loose here (a string) to avoid a types.ts →
  // registry import cycle; createLiveMatch / getGame reject unknown ids.
  gameId: z.string().optional(),
});
export type CreateMatchBody = z.infer<typeof CreateMatchBody>;

export type CreateMatchResponse = {
  matchId: string;
  matchUrl: string; // public-facing, frontend renders /match/<id>
  wsUrl: string; // ws://… already includes ?as=a
};

export const JoinMatchBody = z.object({
  wallet: z.string().min(32).max(64),
  streamId: z.string().min(32).max(64),
});
export type JoinMatchBody = z.infer<typeof JoinMatchBody>;

export type JoinMatchResponse = {
  matchId: string;
  wsUrl: string; // includes ?as=b
};

export type PlayerSlotSnapshot = {
  wallet: string;
  streamId: string;
  connected: boolean;
  effectiveBps: number | null;
  entitledLamports: string | null;
  /** Raw u64 base units locked in this stream (BigInt-safe decimal string).
   *  Multiply by stakeBps/10000 for the wager in token units. Null on legacy. */
  lockedTokenAmount: string | null;
};

export type TokenMetaPublic = {
  mint: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  imageUri: string | null;
};

/**
 * Immutable record of an agreed-to wager. Populated at B-join time on amount-
 * based matches; null on legacy / pre-migration matches that fall back to the
 * symmetric `bpsAtStake` path. Mirrors `WagerSnapshot` in `wager.ts`.
 */
export type WagerSnapshotPublic = {
  /** Absolute amount in raw u64 base units (BigInt-safe decimal string). */
  amountRaw: string;
  /** stakeBps used to derive amountRaw — kept for display ("this is a 10% match"). */
  stakeBps: number;
  /** Per-side lockedTokenAmount snapshot at agreement time. */
  lockedAtMatchTime: { a: string; b: string };
  /** Loser-bps for each outcome, precomputed (rounded up to keep winner credited). */
  bpsIfALoses: number;
  bpsIfBLoses: number;
};

// ───────── Per-game snapshot state ─────────
// Game-specific play state carried in the match snapshot, rendered by that
// game's client. Grows into a discriminated union (on `kind`) as games are
// added. RPS leaves this null (its state is roundIndex + rounds).

export type ReversiSnapshot = {
  kind: "reversi";
  /** Board edge length (8). */
  size: number;
  /** Row-major grid, `board[y][x]`. Each cell is "a" (black) / "b" (white) / null. */
  board: (Side | null)[][];
  /** Whose move it is right now. */
  turn: Side;
  /** The most recent placement, for highlight; null before the first move. */
  lastMove: { x: number; y: number; by: Side } | null;
  /** Live disc counts. */
  counts: { a: number; b: number };
};

export type ChessSnapshot = {
  kind: "chess";
  /** Full position as a FEN string — clients rebuild the board from it. */
  fen: string;
  /** Whose move it is now ("a" = White, "b" = Black). */
  turn: Side;
  /** Most recent move's from/to squares (algebraic, e.g. "e2"→"e4"); null before the first move. */
  lastMove: { from: string; to: string } | null;
  /** True when the side-to-move is in check (for the UI king highlight). */
  check: boolean;
};

export type GameStateSnapshot = ReversiSnapshot | ChessSnapshot;

export type MatchSnapshot = {
  matchId: string;
  /** Which game this match plays ("rps" | "reversi"). Drives client routing. */
  gameId: string;
  state: MatchState;
  pda: string | null;
  tokenMint: string;
  tokenMeta: TokenMetaPublic | null;
  playerA: PlayerSlotSnapshot;
  playerB: PlayerSlotSnapshot | null;
  roundIndex: number;
  rounds: RoundResult[];
  /** Game-specific play state (e.g. the Reversi board). Null for games whose
   *  state is fully described by roundIndex + rounds (RPS). */
  gameState: GameStateSnapshot | null;
  winner: Side | "tie" | null;
  endTs: number | null;
  disputeWindowSec: number;
  finalizeEligibleAt: number | null;
  /** Stake intent in bps. Always populated. Display fallback when `wager` is null. */
  bpsAtStake: number;
  /** Amount-based wager record, when both sides have lockedTokenAmount data. */
  wager: WagerSnapshotPublic | null;
  /** True when the creator opted into the World ID gate; joiners must verify. */
  verifiedOnly: boolean;
  signatures: { kind: TxKind; sig: string }[];
  failedReason: string | null;
};

// ───────── WSS — server-to-client frames ─────────

export type ServerFrame =
  | { type: "hello"; ts: number; matchId: string; you: Side; snapshot: MatchSnapshot }
  | { type: "state"; ts: number; state: MatchState; reason: string }
  | { type: "peer_status"; ts: number; peer: Side; connected: boolean; graceUntil?: number }
  | { type: "round_start"; ts: number; round: number; deadline: number }
  | {
      // Both commits in. Reveal phase open until `deadline`. Commit hashes are
      // forwarded so each client (and any auditor) can later verify the eventual
      // reveal matches what the player committed to.
      type: "commits_locked";
      ts: number;
      round: number;
      deadline: number;
      commits: { a: string; b: string };
    }
  | {
      // yourMove / theirMove are null when that side never validly revealed
      // (commit-phase forfeit, reveal timeout, or BAD_REVEAL).
      type: "round_result";
      ts: number;
      round: number;
      yourMove: Move | null;
      theirMove: Move | null;
      winner: Side | "tie";
      forfeitedBy?: Side | "both";
    }
  | { type: "match_result"; ts: number; winner: Side | "tie"; rounds: RoundResult[] }
  // ── Reversi (board game) ──
  // A disc was placed at (x,y) by `by`, flipping `flipped` opponent discs.
  | { type: "rv_move"; ts: number; by: Side; x: number; y: number; flipped: { x: number; y: number }[] }
  // Whose turn now + the move deadline. `autoPassed` names a side skipped for
  // having no legal move (so the UI can say "opponent had no move").
  | { type: "rv_turn"; ts: number; turn: Side; deadline: number; autoPassed?: Side }
  // ── Chess ──
  // A move was applied; clients load `fen` to sync. `san` feeds the move list, `check` the UI.
  | {
      type: "ch_move";
      ts: number;
      by: Side;
      from: string;
      to: string;
      san: string;
      fen: string;
      check: boolean;
      promotion?: "q" | "r" | "b" | "n";
    }
  // Whose turn now + the move deadline; `check` if that side is in check.
  | { type: "ch_turn"; ts: number; turn: Side; deadline: number; check: boolean }
  | {
      type: "tx";
      ts: number;
      kind: TxKind;
      attempt: number;
      status: "pending" | "confirmed" | "failed";
      sig?: string;
      error?: string;
    }
  | {
      type: "done";
      ts: number;
      winner: Side;
      finalSignatures: { kind: TxKind; sig: string }[];
      explorerLinks: string[];
    }
  | {
      type: "cancelled";
      ts: number;
      reason: "tie" | "abandon" | "stream_busy" | "operator_decision";
      refundSig?: string;
    }
  | { type: "failed"; ts: number; reason: string; contact: string }
  | { type: "error"; ts: number; code: ErrorCode; message: string; fatal: boolean }
  | { type: "ping"; ts: number };

// ───────── WSS — client-to-server frames ─────────

// Commit-reveal protocol (per round):
//   1. client → server: `commit { commitHash }` where commitHash = sha256(move + ":" + nonce).
//   2. server → both clients: `commits_locked` once both commits are in.
//   3. client → server: `reveal { move, nonce }`.
//   4. server verifies sha256(move+":"+nonce) === commitHash, then judges the round.
// commitHash is 64 lowercase hex chars; nonce is 32 lowercase hex chars (16 random bytes).
const HEX_RE = /^[0-9a-f]+$/;
const CommitHashSchema = z.string().length(64).regex(HEX_RE, "commitHash must be 64 lowercase hex chars");
const NonceSchema = z.string().length(32).regex(HEX_RE, "nonce must be 32 lowercase hex chars");

export const ClientFrame = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("commit"),
    round: z.number().int().nonnegative(),
    commitHash: CommitHashSchema,
  }),
  z.object({
    type: z.literal("reveal"),
    round: z.number().int().nonnegative(),
    move: z.enum(MOVES),
    nonce: NonceSchema,
  }),
  z.object({ type: z.literal("forfeit_round"), round: z.number().int().nonnegative() }),
  // Board games: place at (x, y). Bounds are re-checked against the live
  // board size in the engine; 64 is a generous upper bound for any board.
  z.object({
    type: z.literal("place"),
    x: z.number().int().min(0).max(63),
    y: z.number().int().min(0).max(63),
  }),
  // Chess: a move between algebraic squares (e.g. "e2"→"e4"), optional promotion.
  // Legality is enforced server-side by chess.js.
  z.object({
    type: z.literal("chess_move"),
    from: z.string().regex(/^[a-h][1-8]$/),
    to: z.string().regex(/^[a-h][1-8]$/),
    promotion: z.enum(["q", "r", "b", "n"]).optional(),
  }),
  z.object({ type: z.literal("request_resync") }),
  z.object({ type: z.literal("pong") }),
  z.object({ type: z.literal("leave") }),
  // Voluntary whole-match resign — the sender forfeits, opponent wins. Shell-
  // handled (game-agnostic); distinct from RPS's per-round forfeit_round.
  z.object({ type: z.literal("forfeit") }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

// ───────── Errors ─────────

export const ERROR_CODES = [
  "INVALID_STREAM",
  "STREAM_BUSY",
  "MATCH_NOT_FOUND",
  "MATCH_FULL",
  "SLOT_TAKEN",
  "BAD_FRAME",
  "OUT_OF_ORDER_MOVE",
  "BAD_REVEAL",
  "LATE_COMMIT",
  "LATE_REVEAL",
  // Reversi (board game)
  "NOT_YOUR_TURN",
  "CELL_TAKEN",
  "OUT_OF_BOUNDS",
  "ILLEGAL_MOVE",
  "RPC_DEGRADED",
  "INTERNAL",
  // World ID gating
  "WORLDID_REQUIRED",
  "WORLDID_NOT_CONFIGURED",
  "WALLET_MISMATCH",
  "SAME_HUMAN",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class ServerError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public fatal = true,
  ) {
    super(message);
  }
}
