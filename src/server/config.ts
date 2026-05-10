/**
 * Server-specific configuration.
 *
 * Game/operator chain config (OPERATOR_SECRET_KEY_B64, STREAMLOCK_OPERATOR_KEY,
 * SOLANA_RPC_URL, GAME_TOKEN_MINT) lives in src/operator.ts and is loaded
 * from .env.local. This file owns server-only knobs.
 */

import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv({ path: ".env.local" });

const Schema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default("127.0.0.1"),
  DATABASE_PATH: z.string().default("./operator.sqlite"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:8787"),
  PUBLIC_WS_URL: z.string().default("ws://localhost:8787"),
  // Commit-phase deadline: how long each player has to send their hash commitment.
  ROUND_DEADLINE_SEC: z.coerce.number().int().positive().default(45),
  // Reveal-phase deadline: once both commits are in, how long each player has
  // to send (move, nonce). A revealed-but-unrevealing player forfeits the round.
  REVEAL_DEADLINE_SEC: z.coerce.number().int().positive().default(15),
  RECONNECT_GRACE_SEC: z.coerce.number().int().nonnegative().default(30),
  STAKE_BPS: z.coerce.number().int().positive().max(10000).default(1000),
  // Cohort tolerance band for amount-based betting. A pairing is rejected when
  // max(lockedA, lockedB) / min(lockedA, lockedB) exceeds this ratio. 5x is
  // poker-room-tier; tighten to 2-3 if you want chess-style cohorting. Set to
  // a very large number (e.g. 10000) to disable.
  COHORT_MAX_RATIO: z.coerce.number().positive().default(5),
  DISPUTE_WINDOW_SEC: z.coerce.number().int().positive().default(120),
  FINALIZE_BUFFER_SEC: z.coerce.number().int().nonnegative().default(30),
  // endTs = nowSec() + ENDTS_BUFFER_SEC, recomputed per create attempt so
  // retries after a slow confirmation don't reuse a stale, now-past timestamp.
  ENDTS_BUFFER_SEC: z.coerce.number().int().positive().default(30),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  // Drives the Streamlock app explorer link (app.streamlock.fun/<TOKEN_ENV>/<mint>).
  // "soldev" → devnet, "sol" → mainnet. Mirrors STREAMLOCK_CHAIN.
  TOKEN_ENV: z.enum(["sol", "soldev"]).default("soldev"),
});

export const config = Schema.parse(process.env);
export type Config = typeof config;
