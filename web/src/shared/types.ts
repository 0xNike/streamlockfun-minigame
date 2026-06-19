/**
 * Mirrors src/server/types.ts. Manually kept in sync until we extract a shared
 * package; the server is canonical, the frontend follows.
 */

export type Side = "a" | "b";
export type Move = "rock" | "paper" | "scissors";
export type TxKind = "create" | "submit" | "finalize" | "apply" | "cancel";

export type MatchState =
  | "queued"
  | "partnered"
  | "creating"
  | "active"
  | "complete"
  | "submitting"
  | "dispute_wait"
  | "finalizing"
  | "applying"
  | "done"
  | "cancelling"
  | "cancelled"
  | "failed";

export type RoundResult = {
  round: number;
  a: Move | null;
  b: Move | null;
  winner: Side | "tie";
  forfeitedBy?: Side | "both";
};

export type PlayerSlotSnapshot = {
  wallet: string;
  streamId: string;
  connected: boolean;
  effectiveBps: number | null;
  entitledLamports: string | null;
  /** Raw u64 base units locked in this stream as a decimal string (BigInt-safe).
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
 * Immutable record of an agreed-to wager. Mirror of `WagerSnapshotPublic` on
 * the server. Null on legacy matches; populated at B-join on amount-based ones.
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

// Per-game snapshot state (mirrors the server). Grows into a union on `kind`.
export type GomokuSnapshot = {
  kind: "gomoku";
  size: number;
  /** Row-major grid, board[y][x]; each cell is the side that played it, or null. */
  board: (Side | null)[][];
  turn: Side;
  lastMove: { x: number; y: number; by: Side } | null;
};
export type GameStateSnapshot = GomokuSnapshot;

export type MatchSnapshot = {
  matchId: string;
  /** Which game this match plays ("rps" | "gomoku"). Drives client routing. */
  gameId: string;
  state: MatchState;
  pda: string | null;
  tokenMint: string;
  tokenMeta: TokenMetaPublic | null;
  playerA: PlayerSlotSnapshot;
  playerB: PlayerSlotSnapshot | null;
  roundIndex: number;
  rounds: RoundResult[];
  /** Game-specific play state (e.g. the Gomoku board); null for RPS. */
  gameState: GameStateSnapshot | null;
  winner: Side | "tie" | null;
  endTs: number | null;
  disputeWindowSec: number;
  finalizeEligibleAt: number | null;
  /** Stake intent in bps. Always populated. Display fallback when `wager` is null. */
  bpsAtStake: number;
  /** Amount-based wager record, when both sides have lockedTokenAmount data. */
  wager: WagerSnapshotPublic | null;
  /** Creator opted into the World ID gate; joiners must verify before joining. */
  verifiedOnly: boolean;
  signatures: { kind: TxKind; sig: string }[];
  failedReason: string | null;
};

export type ServerFrame =
  | { type: "hello"; ts: number; matchId: string; you: Side; snapshot: MatchSnapshot }
  | { type: "state"; ts: number; state: MatchState; reason: string }
  | { type: "peer_status"; ts: number; peer: Side; connected: boolean; graceUntil?: number }
  | { type: "round_start"; ts: number; round: number; deadline: number }
  | {
      type: "commits_locked";
      ts: number;
      round: number;
      deadline: number;
      commits: { a: string; b: string };
    }
  | {
      type: "round_result";
      ts: number;
      round: number;
      yourMove: Move | null;
      theirMove: Move | null;
      winner: Side | "tie";
      forfeitedBy?: Side | "both";
    }
  | { type: "match_result"; ts: number; winner: Side | "tie"; rounds: RoundResult[] }
  | { type: "gm_move"; ts: number; by: Side; x: number; y: number }
  | { type: "gm_turn"; ts: number; turn: Side; deadline: number }
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
  | { type: "error"; ts: number; code: string; message: string; fatal: boolean }
  | { type: "ping"; ts: number };

export type ClientFrame =
  | { type: "commit"; round: number; commitHash: string }
  | { type: "reveal"; round: number; move: Move; nonce: string }
  | { type: "forfeit_round"; round: number }
  | { type: "place"; x: number; y: number }
  | { type: "request_resync" }
  | { type: "pong" }
  | { type: "leave" };
