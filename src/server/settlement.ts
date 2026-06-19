/**
 * Chain-write layer for the operator server.
 *
 * Wraps the SDK calls (op.sessions.{create, submit, finalizeAndApplyAll, cancel})
 * with a uniform retry/log/broadcast envelope:
 *
 *   1. before each attempt → emit `tx pending` to clients + log "tx.attempt"
 *   2. on success         → write tx_log row(s), emit `tx confirmed` per signature
 *   3. on failure         → write tx_log row, emit `tx failed`, retry per policy
 *
 * Retry policies are conservative (2–3 attempts) and use exponential backoff.
 * Caller catches the final throw and decides what to do (typically transition to `failed`).
 */

import type { DeltaEntry, SessionState } from "@streamlock/operator-sdk";
import { op } from "../operator.js";
import { logTx } from "./db.js";
import { logger } from "./log.js";
import type { ServerFrame, TxKind } from "./types.js";

const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * RPC rate-limit / quota errors (e.g. Helius `-32429 "max usage reached"`,
 * generic 429s). These are transient under burst — session-creation fires
 * several RPC calls in quick succession and can momentarily exceed a provider's
 * RPS cap. They MUST be retryable: runChainOp's backoff (2s→8s→…) clears the
 * window, so a blip retries instead of killing the match. Use a dedicated/paid
 * RPC to avoid them in the first place (required for mainnet).
 */
function isRateLimited(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("429") ||
    msg.includes("-32429") ||
    msg.includes("Too Many Requests") ||
    msg.includes("max usage")
  );
}

export type BroadcastFn = (frame: ServerFrame) => void;

async function runChainOp<T>(args: {
  sessionId: string;
  kind: TxKind;
  broadcast: BroadcastFn;
  maxAttempts: number;
  isRetryable?: (err: unknown) => boolean;
  fn: () => Promise<T>;
  extractSigs: (out: T) => string[];
}): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= args.maxAttempts; attempt++) {
    const start = Date.now();
    args.broadcast({ type: "tx", ts: nowSec(), kind: args.kind, attempt, status: "pending" });
    logger.info({ sessionId: args.sessionId, kind: args.kind, attempt }, "tx.attempt");
    try {
      const out = await args.fn();
      const durationMs = Date.now() - start;
      const sigs = args.extractSigs(out);
      for (const sig of sigs) {
        logTx({ sessionId: args.sessionId, kind: args.kind, signature: sig, attempt, durationMs });
        args.broadcast({
          type: "tx",
          ts: nowSec(),
          kind: args.kind,
          attempt,
          status: "confirmed",
          sig,
        });
      }
      logger.info(
        { sessionId: args.sessionId, kind: args.kind, attempt, sigs, durationMs },
        "tx.confirmed",
      );
      return out;
    } catch (err) {
      lastErr = err;
      const durationMs = Date.now() - start;
      const errStr = err instanceof Error ? err.message : String(err);
      logTx({ sessionId: args.sessionId, kind: args.kind, error: errStr, attempt, durationMs });
      logger.warn(
        { sessionId: args.sessionId, kind: args.kind, attempt, errStr, durationMs },
        "tx.failed",
      );
      args.broadcast({
        type: "tx",
        ts: nowSec(),
        kind: args.kind,
        attempt,
        status: "failed",
        error: errStr,
      });
      const retryable = args.isRetryable ? args.isRetryable(err) : true;
      if (!retryable || attempt >= args.maxAttempts) break;
      const backoffMs = 2000 * Math.pow(4, attempt - 1);
      await sleep(backoffMs);
    }
  }
  throw lastErr;
}

// ───────── public helpers ─────────

/**
 * Idempotent-on-retry create.
 *
 * Devnet RPC reliability is poor: confirmation polling can time out with
 * "block height exceeded" even when the tx actually landed. The on-chain
 * program is NOT idempotent — a retry then hits "Allocate: account ... already
 * in use". We catch that, parse the PDA out of the simulation log, and read
 * the existing session via op.sessions.get(pda) instead of failing the match.
 */
const ALREADY_IN_USE_RE =
  /Allocate: account Address \{ address: ([1-9A-HJ-NP-Za-km-z]+),/;

async function recoverFromAlreadyInUse(
  err: unknown,
  sessionId: string,
): Promise<{ pda: string; sig: string; endTs: number } | null> {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(ALREADY_IN_USE_RE);
  if (!m) return null;
  const pda = m[1];
  try {
    const state: SessionState = await op.sessions.get(pda);
    if (!state.gameSession?.gameSessionPda) return null;
    logger.warn(
      { sessionId, pda, endTs: state.gameSession.endTs, status: state.gameSession.status },
      "settlement.create_recovered_from_chain",
    );
    return {
      pda: state.gameSession.gameSessionPda,
      sig: "recovered_via_chain_read",
      endTs: state.gameSession.endTs,
    };
  } catch (getErr) {
    logger.warn(
      { sessionId, pda, getErr: getErr instanceof Error ? getErr.message : String(getErr) },
      "settlement.create_recovery_get_failed",
    );
    return null;
  }
}

export async function createSession(args: {
  sessionId: string;
  tokenMint: string;
  playerA: { wallet: string; streamId: string };
  playerB: { wallet: string; streamId: string };
  endTsBufferSec: number;
  disputeWindowSec: number;
  broadcast: BroadcastFn;
}): Promise<{ pda: string; sig: string; endTs: number }> {
  // endTs must be in the future at the moment of submission; we recompute it
  // per attempt and capture whichever value the successful attempt used.
  let lastEndTs = 0;
  try {
    const out = (await runChainOp({
      sessionId: args.sessionId,
      kind: "create",
      broadcast: args.broadcast,
      maxAttempts: 4,
      isRetryable: (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        return (
          isRateLimited(err) ||
          msg.includes("block height exceeded") ||
          msg.includes("expired") ||
          msg.includes("fetch failed") ||
          msg.includes("timeout") ||
          msg.includes("ECONN") ||
          msg.includes("503") ||
          msg.includes("502")
        );
      },
      fn: () => {
        lastEndTs = Math.floor(Date.now() / 1000) + args.endTsBufferSec;
        return op.sessions.create({
          tokenMint: args.tokenMint,
          participants: [
            { wallet: args.playerA.wallet, streamId: args.playerA.streamId },
            { wallet: args.playerB.wallet, streamId: args.playerB.streamId },
          ],
          endTs: lastEndTs,
          disputeWindowSec: args.disputeWindowSec,
          sessionIdHex: args.sessionId,
        } as Parameters<typeof op.sessions.create>[0]);
      },
      extractSigs: (out) => [(out as { signature: string }).signature],
    })) as { signature: string; result: { gameSessionPda: string } };
    return { pda: out.result.gameSessionPda, sig: out.signature, endTs: lastEndTs };
  } catch (err) {
    const recovered = await recoverFromAlreadyInUse(err, args.sessionId);
    if (recovered) {
      args.broadcast({
        type: "tx",
        ts: Math.floor(Date.now() / 1000),
        kind: "create",
        attempt: 0,
        status: "confirmed",
        sig: recovered.sig,
      });
      return recovered;
    }
    throw err;
  }
}

function isAlreadyInUse(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return ALREADY_IN_USE_RE.test(msg);
}

export async function submitDeltas(args: {
  sessionId: string;
  pda: string;
  deltas: DeltaEntry[];
  broadcast: BroadcastFn;
}): Promise<string> {
  try {
    const out = (await runChainOp({
      sessionId: args.sessionId,
      kind: "submit",
      broadcast: args.broadcast,
      maxAttempts: 3,
      // Only retry transient confirmation failures. "block height exceeded"
      // can fire even when the tx actually landed (lost confirmation); on retry
      // we hit the already-in-use case below and treat it as success. Without
      // this filter the default retried ALL errors, turning a landed-but-
      // unconfirmed submit into a hard failure on the "already in use" retry.
      isRetryable: (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        return (
          isRateLimited(err) ||
          msg.includes("block height exceeded") ||
          msg.includes("expired") ||
          msg.includes("fetch failed") ||
          msg.includes("timeout") ||
          msg.includes("ECONN") ||
          msg.includes("503") ||
          msg.includes("502")
        );
      },
      fn: () => op.sessions.submit(args.pda, { startChunkIndex: 0, deltas: args.deltas }),
      extractSigs: (out) => [(out as { signature: string }).signature],
    })) as { signature: string };
    return out.signature;
  } catch (err) {
    // "Allocate: account ... already in use" on SubmitResults means a prior
    // attempt's tx actually landed (confirmation was lost and we retried). The
    // results account exists on-chain → submit is done. Treat as success so
    // settlement proceeds to finalize, rather than failing an already-recorded
    // (and paid-for) match. Mirrors recoverFromAlreadyInUse for create.
    if (isAlreadyInUse(err)) {
      logger.warn(
        { sessionId: args.sessionId },
        "settlement.submit_recovered_already_submitted",
      );
      args.broadcast({
        type: "tx",
        ts: nowSec(),
        kind: "submit",
        attempt: 0,
        status: "confirmed",
        sig: "recovered_via_chain_read",
      });
      return "recovered_via_chain_read";
    }
    throw err;
  }
}

export async function finalizeAndApply(args: {
  sessionId: string;
  pda: string;
  deltas: DeltaEntry[];
  broadcast: BroadcastFn;
}): Promise<{ finalizeSigs: string[]; applySigs: string[] }> {
  const out = (await runChainOp({
    sessionId: args.sessionId,
    kind: "finalize",
    broadcast: args.broadcast,
    maxAttempts: 3,
    isRetryable: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      // 0x1780 = DisputeWindowNotEnded → chain time still behind; backoff helps.
      // Network blips also retryable.
      return (
        isRateLimited(err) ||
        msg.includes("DisputeWindowNotEnded") ||
        msg.includes("0x1780") ||
        msg.includes("fetch failed") ||
        msg.includes("timeout") ||
        msg.includes("ECONN")
      );
    },
    fn: () =>
      op.sessions.finalizeAndApplyAll(args.pda, [{ chunkIndex: 0, deltas: args.deltas }]),
    extractSigs: (out) => {
      const o = out as { finalize?: string[]; apply?: string[] };
      return [...(o.finalize ?? []), ...(o.apply ?? [])];
    },
  })) as { finalize?: string[]; apply?: string[] };
  return { finalizeSigs: out.finalize ?? [], applySigs: out.apply ?? [] };
}

export async function cancelSession(args: {
  sessionId: string;
  pda: string;
  broadcast: BroadcastFn;
}): Promise<string> {
  const out = (await runChainOp({
    sessionId: args.sessionId,
    kind: "cancel",
    broadcast: args.broadcast,
    maxAttempts: 2,
    fn: () => op.sessions.cancel(args.pda),
    extractSigs: (out) => [(out as { signature: string }).signature],
  })) as { signature: string };
  return out.signature;
}
