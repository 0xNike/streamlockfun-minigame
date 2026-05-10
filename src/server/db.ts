/**
 * SQLite persistence for the operator server.
 *
 * Schema serves three purposes:
 *   1. Match-level state machine — every transition is written before being acted on (write-ahead).
 *   2. Per-round move history — replay-able in case the server crashes mid-match.
 *   3. tx_log — audit trail of every on-chain attempt with attempt-number for retry visibility.
 *
 * On startup, the reconciler reads sessions in non-terminal states and rolls forward.
 */

import Database from "better-sqlite3";
import { config } from "./config.js";
import { logger } from "./log.js";
import type { MatchState, Move, RoundResult, Side, TxKind } from "./types.js";

export const db = new Database(config.DATABASE_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id                       TEXT PRIMARY KEY,
    pda                      TEXT,
    state                    TEXT NOT NULL,
    token_mint               TEXT,
    player_a_wallet          TEXT NOT NULL,
    player_a_stream          TEXT NOT NULL,
    player_b_wallet          TEXT,
    player_b_stream          TEXT,
    end_ts                   INTEGER,
    dispute_window_sec       INTEGER NOT NULL,
    bps_at_stake             INTEGER NOT NULL,
    -- Wager snapshot (amount-based betting; nullable for ratcheting old rows).
    -- All five are populated together at B-join time. Settlement reads these
    -- when present; falls back to bps_at_stake symmetric path when null.
    wager_amount_raw         TEXT,
    locked_a_at_match_time   TEXT,
    locked_b_at_match_time   TEXT,
    bps_if_a_loses           INTEGER,
    bps_if_b_loses           INTEGER,
    round_index              INTEGER NOT NULL DEFAULT 0,
    rounds_json              TEXT NOT NULL DEFAULT '[]',
    winner                   TEXT,
    deltas_json              TEXT,
    failed_reason            TEXT,
    created_at               INTEGER NOT NULL,
    updated_at               INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_state ON sessions(state);
  CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);

  -- Per-round commit-reveal log. Row is created at commit time
  -- (move/nonce/revealed_at NULL); update sets the reveal columns.
  CREATE TABLE IF NOT EXISTS moves (
    session_id    TEXT NOT NULL,
    round         INTEGER NOT NULL,
    player        TEXT NOT NULL,
    move          TEXT,
    commit_hash   TEXT,
    nonce         TEXT,
    received_at   INTEGER NOT NULL,
    revealed_at   INTEGER,
    PRIMARY KEY (session_id, round, player),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS tx_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    kind        TEXT NOT NULL,
    signature   TEXT,
    error       TEXT,
    attempt     INTEGER NOT NULL,
    duration_ms INTEGER,
    ts          INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_tx_log_session ON tx_log(session_id);
`);

// Migrations for previously-deployed schemas (v0 is forgiving — additive only).
const sessionCols = db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
const sessionColNames = new Set(sessionCols.map((c) => c.name));
if (!sessionColNames.has("token_mint")) {
  db.exec(`ALTER TABLE sessions ADD COLUMN token_mint TEXT`);
}
// Wager snapshot columns (amount-based betting). All nullable so pre-migration
// rows retain the symmetric bps_at_stake path; new rows populate the snapshot.
for (const [col, type] of [
  ["wager_amount_raw", "TEXT"],
  ["locked_a_at_match_time", "TEXT"],
  ["locked_b_at_match_time", "TEXT"],
  ["bps_if_a_loses", "INTEGER"],
  ["bps_if_b_loses", "INTEGER"],
] as const) {
  if (!sessionColNames.has(col)) {
    db.exec(`ALTER TABLE sessions ADD COLUMN ${col} ${type}`);
  }
}

// moves table: commit-reveal migration. The old schema had `move NOT NULL`;
// the new schema makes `move` nullable (commit-time row, reveal fills it in)
// and adds `commit_hash`, `nonce`, `revealed_at`. SQLite can't drop NOT NULL
// in place, so we rebuild via a temp table when an old schema is detected.
const moveCols = db.prepare(`PRAGMA table_info(moves)`).all() as {
  name: string;
  notnull: number;
}[];
const hasCommitHash = moveCols.some((c) => c.name === "commit_hash");
const moveColInfo = moveCols.find((c) => c.name === "move");
const moveIsNotNull = moveColInfo?.notnull === 1;
if (moveCols.length > 0 && (!hasCommitHash || moveIsNotNull)) {
  logger.info({ hasCommitHash, moveIsNotNull }, "db.migrating_moves_table");
  db.exec(`
    BEGIN;
    CREATE TABLE moves_new (
      session_id    TEXT NOT NULL,
      round         INTEGER NOT NULL,
      player        TEXT NOT NULL,
      move          TEXT,
      commit_hash   TEXT,
      nonce         TEXT,
      received_at   INTEGER NOT NULL,
      revealed_at   INTEGER,
      PRIMARY KEY (session_id, round, player),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    INSERT INTO moves_new (session_id, round, player, move, received_at, revealed_at)
      SELECT session_id, round, player, move, received_at, received_at FROM moves;
    DROP TABLE moves;
    ALTER TABLE moves_new RENAME TO moves;
    COMMIT;
  `);
}

logger.info({ path: config.DATABASE_PATH }, "db.ready");

// ───────── DAOs ─────────

export type SessionRow = {
  id: string;
  pda: string | null;
  state: MatchState;
  token_mint: string | null;
  player_a_wallet: string;
  player_a_stream: string;
  player_b_wallet: string | null;
  player_b_stream: string | null;
  end_ts: number | null;
  dispute_window_sec: number;
  bps_at_stake: number;
  // Wager snapshot — null on legacy rows, populated together at B-join.
  wager_amount_raw: string | null;
  locked_a_at_match_time: string | null;
  locked_b_at_match_time: string | null;
  bps_if_a_loses: number | null;
  bps_if_b_loses: number | null;
  round_index: number;
  rounds_json: string;
  winner: Side | "tie" | null;
  deltas_json: string | null;
  failed_reason: string | null;
  created_at: number;
  updated_at: number;
};

const insertSessionStmt = db.prepare(`
  INSERT INTO sessions (
    id, state, token_mint, player_a_wallet, player_a_stream,
    dispute_window_sec, bps_at_stake, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function insertSession(args: {
  id: string;
  state: MatchState;
  tokenMint: string;
  playerAWallet: string;
  playerAStream: string;
  disputeWindowSec: number;
  bpsAtStake: number;
}): void {
  const now = Math.floor(Date.now() / 1000);
  insertSessionStmt.run(
    args.id,
    args.state,
    args.tokenMint,
    args.playerAWallet,
    args.playerAStream,
    args.disputeWindowSec,
    args.bpsAtStake,
    now,
    now,
  );
}

const getSessionStmt = db.prepare<[string], SessionRow>(`SELECT * FROM sessions WHERE id = ?`);

export function getSession(id: string): SessionRow | undefined {
  return getSessionStmt.get(id);
}

const updateStateStmt = db.prepare(`UPDATE sessions SET state = ?, updated_at = ? WHERE id = ?`);

export function setSessionState(id: string, state: MatchState): void {
  updateStateStmt.run(state, Math.floor(Date.now() / 1000), id);
}

const setPdaStmt = db.prepare(
  `UPDATE sessions SET pda = ?, end_ts = ?, updated_at = ? WHERE id = ?`,
);

export function setSessionPda(id: string, pda: string, endTs: number): void {
  setPdaStmt.run(pda, endTs, Math.floor(Date.now() / 1000), id);
}

const setPlayerBStmt = db.prepare(
  `UPDATE sessions SET player_b_wallet = ?, player_b_stream = ?, state = ?, updated_at = ? WHERE id = ?`,
);

export function setPlayerB(
  id: string,
  wallet: string,
  streamId: string,
  state: MatchState,
): void {
  setPlayerBStmt.run(wallet, streamId, state, Math.floor(Date.now() / 1000), id);
}

const setWagerSnapshotStmt = db.prepare(`
  UPDATE sessions SET
    wager_amount_raw = ?,
    locked_a_at_match_time = ?,
    locked_b_at_match_time = ?,
    bps_if_a_loses = ?,
    bps_if_b_loses = ?,
    updated_at = ?
  WHERE id = ?
`);

/** Persist the agreed-to wager snapshot. Called once at B-join, never updated. */
export function setWagerSnapshot(
  id: string,
  snap: {
    amountRaw: string;
    lockedA: string;
    lockedB: string;
    bpsIfALoses: number;
    bpsIfBLoses: number;
  },
): void {
  setWagerSnapshotStmt.run(
    snap.amountRaw,
    snap.lockedA,
    snap.lockedB,
    snap.bpsIfALoses,
    snap.bpsIfBLoses,
    Math.floor(Date.now() / 1000),
    id,
  );
}

const setRoundsStmt = db.prepare(
  `UPDATE sessions SET rounds_json = ?, round_index = ?, updated_at = ? WHERE id = ?`,
);

export function setRounds(id: string, rounds: RoundResult[], roundIndex: number): void {
  setRoundsStmt.run(JSON.stringify(rounds), roundIndex, Math.floor(Date.now() / 1000), id);
}

const setWinnerStmt = db.prepare(
  `UPDATE sessions SET winner = ?, deltas_json = ?, state = ?, updated_at = ? WHERE id = ?`,
);

export function setWinner(
  id: string,
  winner: Side | "tie",
  deltas: unknown,
  state: MatchState,
): void {
  setWinnerStmt.run(
    winner,
    deltas ? JSON.stringify(deltas) : null,
    state,
    Math.floor(Date.now() / 1000),
    id,
  );
}

const setFailedStmt = db.prepare(
  `UPDATE sessions SET state = ?, failed_reason = ?, updated_at = ? WHERE id = ?`,
);

export function setFailed(id: string, state: MatchState, reason: string): void {
  setFailedStmt.run(state, reason, Math.floor(Date.now() / 1000), id);
}

const nonTerminalStmt = db.prepare<[], SessionRow>(`
  SELECT * FROM sessions
  WHERE state NOT IN ('done', 'cancelled', 'failed')
  ORDER BY updated_at ASC
`);

export function listNonTerminalSessions(): SessionRow[] {
  return nonTerminalStmt.all();
}

const stuckSessionsStmt = db.prepare<[number], SessionRow>(`
  SELECT * FROM sessions
  WHERE state NOT IN ('done', 'cancelled', 'failed')
    AND updated_at < ?
  ORDER BY updated_at ASC
  LIMIT 100
`);

export function listStuckSessions(staleBefore: number): SessionRow[] {
  return stuckSessionsStmt.all(staleBefore);
}

// ───────── moves (commit-reveal) ─────────

const insertCommitStmt = db.prepare(
  `INSERT INTO moves (session_id, round, player, commit_hash, received_at)
   VALUES (?, ?, ?, ?, ?)`,
);

export function insertCommit(
  sessionId: string,
  round: number,
  player: Side,
  commitHash: string,
): void {
  insertCommitStmt.run(sessionId, round, player, commitHash, Math.floor(Date.now() / 1000));
}

const recordRevealStmt = db.prepare(
  `UPDATE moves SET move = ?, nonce = ?, revealed_at = ?
   WHERE session_id = ? AND round = ? AND player = ?`,
);

export function recordReveal(
  sessionId: string,
  round: number,
  player: Side,
  move: Move,
  nonce: string,
): void {
  recordRevealStmt.run(move, nonce, Math.floor(Date.now() / 1000), sessionId, round, player);
}

const movesForRoundStmt = db.prepare<[string, number]>(
  `SELECT * FROM moves WHERE session_id = ? AND round = ?`,
);

export function movesForRound(
  sessionId: string,
  round: number,
): { player: Side; move: Move | null; commit_hash: string | null }[] {
  return movesForRoundStmt.all(sessionId, round) as {
    player: Side;
    move: Move | null;
    commit_hash: string | null;
  }[];
}

// ───────── tx_log ─────────

const insertTxLogStmt = db.prepare(
  `INSERT INTO tx_log (session_id, kind, signature, error, attempt, duration_ms, ts) VALUES (?, ?, ?, ?, ?, ?, ?)`,
);

export function logTx(args: {
  sessionId: string;
  kind: TxKind;
  signature?: string;
  error?: string;
  attempt: number;
  durationMs?: number;
}): void {
  insertTxLogStmt.run(
    args.sessionId,
    args.kind,
    args.signature ?? null,
    args.error ?? null,
    args.attempt,
    args.durationMs ?? null,
    Math.floor(Date.now() / 1000),
  );
}

const signaturesForSessionStmt = db.prepare<[string]>(`
  SELECT kind, signature FROM tx_log
  WHERE session_id = ? AND signature IS NOT NULL AND error IS NULL
  ORDER BY id ASC
`);

export function signaturesForSession(sessionId: string): { kind: TxKind; sig: string }[] {
  return (signaturesForSessionStmt.all(sessionId) as { kind: TxKind; signature: string }[]).map(
    (r) => ({ kind: r.kind, sig: r.signature }),
  );
}
