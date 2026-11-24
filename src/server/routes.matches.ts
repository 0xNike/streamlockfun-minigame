/**
 * Real HTTP handlers for /api/matches/*.
 *
 * Validates inputs with zod, never throws raw — every error path returns the
 * { error: { code, message, fatal } } envelope from the contract.
 */

import type { FastifyInstance } from "fastify";
import { op, GAME_TOKEN_MINT } from "../operator.js";
import { config } from "./config.js";
import { logger } from "./log.js";
import { listLive, getLive, createLiveMatch, type LiveMatch } from "./matches.js";
import { getTokenMeta } from "./tokenmeta.js";
import {
  CreateMatchBody,
  JoinMatchBody,
  type CreateMatchResponse,
  type JoinMatchResponse,
} from "./types.js";
import {
  amountFromStakeBps,
  materialiseWager,
  type WagerSnapshot,
  type WagerError,
} from "./wager.js";
import { SESSION_COOKIE, isWorldIdConfigured, isWalletVerified, verifySession } from "./worldid.js";
import { findBusyStreamSession } from "./db.js";
import { authedWallet } from "./auth.js";

/** create/join must come from the wallet that signed in (Bearer token). */
function authReject(req: Parameters<typeof authedWallet>[0], wallet: string): GuardReject | null {
  const signedIn = authedWallet(req);
  if (!signedIn) {
    return { status: 401, code: "AUTH_REQUIRED", message: "Sign in with your wallet first." };
  }
  if (signedIn !== wallet) {
    return { status: 403, code: "WALLET_MISMATCH", message: "You're signed in with a different wallet than this request uses." };
  }
  return null;
}
import {
  effectiveDisputeWindowSec,
  hasActiveReservation,
  holderBps,
  maxLossBps,
  minEntryViolation,
  readRouterConfig,
  readRouterParams,
  readStakeViews,
  readStreamStates,
  stakeGuard,
} from "./routerChain.js";

type GuardReject = { status: number; code: string; message: string };

/** One match per stream at a time (see findBusyStreamSession). */
function busyReject(streamId: string, excludeSessionId?: string): GuardReject | null {
  const busy = findBusyStreamSession(streamId, excludeSessionId);
  if (!busy) return null;
  return {
    status: 409,
    code: "STREAM_BUSY",
    message:
      "This stream is already staked in another match that hasn't finished settling. " +
      "Wait for it to finish, or pick a different stream.",
  };
}

/**
 * Chain pre-checks for a pairing. Each failure here would otherwise surface
 * only at apply time, after the match was played. Returns each side's on-chain
 * bps in its own stream, used to size the wager against what the player holds.
 */
async function chainGuard(args: {
  tokenMint: string;
  a: { wallet: string; streamId: string };
  b: { wallet: string; streamId: string } | null;
}): Promise<{ ok: true; sizing: PairSizing } | ({ ok: false } & GuardReject)> {
  let states;
  let maxEntries;
  let params;
  let views;
  try {
    const ids = args.b ? [args.a.streamId, args.b.streamId] : [args.a.streamId];
    [states, { maxEntitlementEntriesPerChunk: maxEntries }, params] = await Promise.all([
      readStreamStates(ids),
      readRouterConfig(),
      readRouterParams(),
    ]);
    const who = args.b ? [args.a, args.b] : [args.a];
    views = await readStakeViews(
      who.map((w, i) => ({ streamId: w.streamId, holder: w.wallet, bps: holderBps(states![i], w.wallet) })),
    );
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "chain_guard.read_failed");
    return {
      ok: false,
      status: 503,
      code: "CHAIN_UNAVAILABLE",
      message: "Couldn't read the stream on-chain right now — please try again in a moment.",
    };
  }
  const sides = [
    { who: args.a, opp: args.b?.wallet ?? null, state: states[0], view: views[0] },
    ...(args.b ? [{ who: args.b, opp: args.a.wallet, state: states[1], view: views[1] }] : []),
  ];
  for (const s of sides) {
    const bad = stakeGuard({
      state: s.state,
      wallet: s.who.wallet,
      opponent: s.opp,
      tokenMint: args.tokenMint,
      maxEntries,
    });
    if (bad) return { ok: false, status: 422, code: bad.code, message: bad.message };
    // A reservation still bound to any session (another game, a lottery
    // ticket) blocks reserve_stake on-chain (StakeAlreadyReserved).
    if (hasActiveReservation(s.view)) {
      return {
        ok: false,
        status: 409,
        code: "STREAM_RESERVED",
        message: "Part of this stream is still locked by another match. Wait for it to finish, or pick a different stream.",
      };
    }
    if (maxLossBps(s.view) <= 0) {
      return {
        ok: false,
        status: 422,
        code: "STREAM_NOTHING_UNSOLD",
        message: "You've already sold your share of this stream, so there's nothing left to stake.",
      };
    }
  }
  return {
    ok: true,
    sizing: {
      maxLossA: maxLossBps(views[0]),
      maxLossB: args.b ? maxLossBps(views[1]) : 0,
      bpsA: views[0].bps,
      bpsB: args.b ? views[1].bps : 0,
      // Winner's existing entry in the LOSER's stream (min-entry check).
      bInStreamA: args.b ? holderBps(states[0], args.b.wallet) : 0,
      aInStreamB: args.b ? holderBps(states[1], args.a.wallet) : 0,
      minEntryBps: params.minEntryBps,
    },
  };
}

interface PairSizing {
  /** Max bps each side can lose in its own stream (unsold predicate). */
  maxLossA: number;
  maxLossB: number;
  /** Each side's current bps in its own stream. */
  bpsA: number;
  bpsB: number;
  bInStreamA: number;
  aInStreamB: number;
  minEntryBps: number;
}

/** Both outcomes must leave every changed entry at 0 or ≥ min_entry_bps. */
function minEntryReject(sz: PairSizing, lossIfALoses: number, lossIfBLoses: number): GuardReject | null {
  const v =
    minEntryViolation({ loserBps: sz.bpsA, winnerExistingBps: sz.bInStreamA, loss: lossIfALoses, minEntryBps: sz.minEntryBps }) ??
    minEntryViolation({ loserBps: sz.bpsB, winnerExistingBps: sz.aInStreamB, loss: lossIfBLoses, minEntryBps: sz.minEntryBps });
  if (!v) return null;
  return { status: 422, code: "STAKE_BELOW_MIN_ENTRY", message: `This stake doesn't fit the on-chain share rules: ${v}.` };
}

function wsUrl(matchId: string, side: "a" | "b"): string {
  return `${config.PUBLIC_WS_URL}/ws/match/${matchId}?as=${side}`;
}

function matchUrl(matchId: string): string {
  return `${config.PUBLIC_BASE_URL}/match/${matchId}`;
}

/**
 * Guard: a wallet must actually own a share of the stream it stakes. A stream
 * whose `effectiveBps` is 0 is held-of-record but 0%-owned (its position was
 * shifted away in prior games) — staking it is meaningless and must be rejected.
 *
 * We read the wallet's entitlement share and retry once on a transient miss.
 * When ownership is genuinely unverifiable (the entitlement endpoint returns no
 * `effectiveBps` — currently the case against api-devnet, see the platform
 * handoff), the policy is EXPLICIT, not silent: `STRICT_STREAM_OWNERSHIP=true`
 * fails closed (reject — mainnet-safe); the default fails open but logs a warning
 * so the gap is visible rather than hidden.
 */
async function assertOwnsStream(
  wallet: string,
  streamId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  let effBps: number | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const ent = (await op.streams.entitlement(streamId, wallet)) as { effectiveBps?: number };
      if (typeof ent.effectiveBps === "number") {
        effBps = ent.effectiveBps;
        break;
      }
    } catch {
      /* transient — fall through to retry */
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 400));
  }

  if (typeof effBps === "number") {
    if (effBps <= 0) {
      return {
        ok: false,
        message: "You own 0% of this stream — you can't stake it. Pick a stream you hold a position in.",
      };
    }
    return { ok: true }; // owns a positive share
  }

  // Ownership unverifiable (no effectiveBps after retry).
  if (config.STRICT_STREAM_OWNERSHIP) {
    logger.warn({ wallet, streamId }, "ownership.unverifiable_reject");
    return {
      ok: false,
      message: "Couldn't verify your ownership of this stream right now — please try again in a moment.",
    };
  }
  logger.warn({ wallet, streamId }, "ownership.unverifiable_allow");
  return { ok: true };
}

export function registerMatchRoutes(app: FastifyInstance): void {
  app.post("/api/matches", async (req, reply) => {
    const parsed = CreateMatchBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "BAD_FRAME",
          message: parsed.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; "),
          fatal: true,
        },
      });
    }
    const body = parsed.data;
    const authA = authReject(req, body.wallet);
    if (authA) {
      return reply.code(authA.status).send({ error: { code: authA.code, message: authA.message, fatal: true } });
    }
    const ownsA = await assertOwnsStream(body.wallet, body.streamId);
    if (!ownsA.ok) {
      return reply.code(422).send({
        error: { code: "INVALID_STREAM", message: ownsA.message, fatal: true },
      });
    }
    const tokenMint = body.tokenMint ?? GAME_TOKEN_MINT;
    const busyA = busyReject(body.streamId);
    if (busyA) {
      return reply.code(busyA.status).send({ error: { code: busyA.code, message: busyA.message, fatal: true } });
    }
    const guardA = await chainGuard({ tokenMint, a: { wallet: body.wallet, streamId: body.streamId }, b: null });
    if (!guardA.ok) {
      return reply.code(guardA.status).send({ error: { code: guardA.code, message: guardA.message, fatal: true } });
    }
    let disputeWindowSec: number;
    try {
      disputeWindowSec = await effectiveDisputeWindowSec(config.DISPUTE_WINDOW_SEC);
    } catch {
      return reply.code(503).send({
        error: { code: "CHAIN_UNAVAILABLE", message: "Couldn't read the router config — please try again in a moment.", fatal: false },
      });
    }
    let creatorNullifier: string | null = null;
    if (body.verifiedOnly) {
      if (!isWorldIdConfigured()) {
        return reply.code(503).send({
          error: {
            code: "WORLDID_NOT_CONFIGURED",
            message: "this server has no World ID configuration",
            fatal: true,
          },
        });
      }
      if (!isWalletVerified(req.cookies?.[SESSION_COOKIE], body.wallet)) {
        return reply.code(401).send({
          error: {
            code: "WORLDID_REQUIRED",
            message: "verify with World ID before creating a verified-only match",
            fatal: true,
          },
        });
      }
      // Capture the creator's nullifier so the join handler can reject the
      // same-human-as-opponent case (one human re-verifying with a second
      // wallet to play themselves).
      creatorNullifier = verifySession(req.cookies?.[SESSION_COOKIE])?.nullifier ?? null;
    }
    const match = createLiveMatch({
      tokenMint,
      playerAWallet: body.wallet,
      playerAStream: body.streamId,
      bpsAtStake: body.bpsAtStake ?? config.STAKE_BPS,
      disputeWindowSec,
      desiredWagerAmountRaw: body.wagerAmountRaw,
      verifiedOnly: body.verifiedOnly,
      creatorNullifier,
      gameId: body.gameId,
    });
    const res: CreateMatchResponse = {
      matchId: match.id,
      matchUrl: matchUrl(match.id),
      wsUrl: wsUrl(match.id, "a"),
    };
    return reply.code(201).send(res);
  });

  app.post<{ Params: { id: string } }>("/api/matches/:id/join", async (req, reply) => {
    const parsed = JoinMatchBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "BAD_FRAME",
          message: parsed.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; "),
          fatal: true,
        },
      });
    }
    const match = getLive(req.params.id);
    if (!match) {
      return reply.code(404).send({
        error: { code: "MATCH_NOT_FOUND", message: "no match with that id", fatal: true },
      });
    }
    if (!match.hasSlotForB()) {
      return reply.code(409).send({
        error: { code: "MATCH_FULL", message: "match already has B", fatal: true },
      });
    }
    const authB = authReject(req, parsed.data.wallet);
    if (authB) {
      return reply.code(authB.status).send({ error: { code: authB.code, message: authB.message, fatal: true } });
    }
    const ownsB = await assertOwnsStream(parsed.data.wallet, parsed.data.streamId);
    if (!ownsB.ok) {
      return reply.code(422).send({
        error: { code: "INVALID_STREAM", message: ownsB.message, fatal: true },
      });
    }
    if (match.verifiedOnly) {
      if (!isWorldIdConfigured()) {
        return reply.code(503).send({
          error: {
            code: "WORLDID_NOT_CONFIGURED",
            message: "match requires World ID but server is not configured",
            fatal: true,
          },
        });
      }
      if (!isWalletVerified(req.cookies?.[SESSION_COOKIE], parsed.data.wallet)) {
        return reply.code(401).send({
          error: {
            code: "WORLDID_REQUIRED",
            message: "verify with World ID to join a verified-only match",
            fatal: true,
          },
        });
      }
      // Same-human guard: one World ID can re-verify with a second wallet,
      // but it can't oppose itself in a verified-only match.
      const joinerNullifier =
        verifySession(req.cookies?.[SESSION_COOKIE])?.nullifier ?? null;
      if (
        match.creatorNullifier &&
        joinerNullifier &&
        joinerNullifier === match.creatorNullifier
      ) {
        return reply.code(409).send({
          error: {
            code: "SAME_HUMAN",
            message: "you cannot join a verified-only match you created",
            fatal: true,
          },
        });
      }
    }

    // Try to materialise an amount-based WagerSnapshot for this pairing. We
    // fall back to the legacy bpsAtStake-symmetric path only when the SDK
    // doesn't have lockedTokenAmount for one of the streams (legacy rows
    // pre-2026-04-29). Cohort band and amount-validity errors are hard fails
    // surfaced as 422s — joiner sees a clear "stream sizes too different"
    // message rather than getting silently EV-bled.
    const joiner = { wallet: parsed.data.wallet, streamId: parsed.data.streamId };
    if (joiner.streamId === match.playerA.streamId) {
      return reply.code(409).send({
        error: { code: "SAME_STREAM", message: "you can't stake the same stream as your opponent", fatal: true },
      });
    }
    const guard = await chainGuard({
      tokenMint: match.tokenMint,
      a: { wallet: match.playerA.wallet, streamId: match.playerA.streamId },
      b: joiner,
    });
    if (!guard.ok) {
      return reply.code(guard.status).send({ error: { code: guard.code, message: guard.message, fatal: true } });
    }

    const sz = guard.sizing;
    const wagerOrErr = await tryMaterialiseWager(match, joiner.streamId, {
      a: sz.maxLossA,
      b: sz.maxLossB,
    });
    if (wagerOrErr.kind === "reject") {
      return reply.code(422).send({
        error: { code: wagerOrErr.code, message: wagerOrErr.message, fatal: true },
      });
    }
    // Legacy symmetric path (no locked sizes): the loss is bpsAtStake of the
    // loser's stream, so each side must hold at least that much.
    if (!wagerOrErr.wager && Math.min(sz.maxLossA, sz.maxLossB) < match.bpsAtStake) {
      return reply.code(422).send({
        error: {
          code: "STAKE_EXCEEDS_SHARE",
          message: `This match stakes ${match.bpsAtStake} bps, but one side holds less than that of its stream.`,
          fatal: true,
        },
      });
    }

    const lossIfALoses = wagerOrErr.wager?.bpsIfALoses ?? match.bpsAtStake;
    const lossIfBLoses = wagerOrErr.wager?.bpsIfBLoses ?? match.bpsAtStake;
    const minBad = minEntryReject(sz, lossIfALoses, lossIfBLoses);
    if (minBad) {
      return reply.code(minBad.status).send({ error: { code: minBad.code, message: minBad.message, fatal: true } });
    }

    // Busy check runs LAST, with no await between it and joinAsB (which
    // flips the row to "creating" synchronously), so two concurrent joins
    // can't both claim the same stream.
    const busy = busyReject(match.playerA.streamId, match.id) ?? busyReject(joiner.streamId, match.id);
    if (busy) {
      return reply.code(busy.status).send({ error: { code: busy.code, message: busy.message, fatal: true } });
    }

    try {
      match.joinAsB(parsed.data.wallet, parsed.data.streamId, wagerOrErr.wager);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = msg === "MATCH_FULL" || msg === "CANNOT_SELF_MATCH" ? msg : "INTERNAL";
      return reply.code(409).send({ error: { code, message: msg, fatal: true } });
    }
    const res: JoinMatchResponse = {
      matchId: match.id,
      wsUrl: wsUrl(match.id, "b"),
    };
    return reply.code(200).send(res);
  });

  app.get<{ Params: { id: string } }>("/api/matches/:id", async (req, reply) => {
    const match = getLive(req.params.id);
    if (!match) {
      return reply.code(404).send({
        error: { code: "MATCH_NOT_FOUND", message: "no match with that id", fatal: true },
      });
    }
    return reply.send(match.snapshot());
  });

  app.get("/api/config", async () => ({
    tokenMint: GAME_TOKEN_MINT,
    tokenMeta: await getTokenMeta(GAME_TOKEN_MINT),
    stakeBps: config.STAKE_BPS,
    disputeWindowSec: await effectiveDisputeWindowSec(config.DISPUTE_WINDOW_SEC).catch(
      () => config.DISPUTE_WINDOW_SEC,
    ),
    cohortMaxRatio: config.COHORT_MAX_RATIO,
    explorerCluster: config.TOKEN_ENV === "sol" ? "mainnet" : "devnet",
    tokenEnv: config.TOKEN_ENV,
    // Absolute WS base — must be the operator's own host, not the FE's. Vercel
    // rewrites only proxy HTTP, so the WebSocket upgrade has to bypass the
    // rewrite and go straight to the operator on Fly.
    wsBase: config.PUBLIC_WS_URL,
    worldId: isWorldIdConfigured()
      ? {
          enabled: true,
          appId: config.WORLD_APP_ID!,
          action: config.WORLD_ACTION,
          environment: config.WORLD_ENVIRONMENT,
        }
      : { enabled: false },
  }));

  app.get<{ Params: { mint: string } }>("/api/tokens/:mint", async (req) => {
    return await getTokenMeta(req.params.mint);
  });

  app.get<{ Querystring: { wallet?: string; tokenMint?: string } }>(
    "/api/streams",
    async (req, reply) => {
      const wallet = req.query.wallet?.trim();
      if (!wallet) {
        return reply.code(400).send({
          error: { code: "BAD_FRAME", message: "missing ?wallet=", fatal: true },
        });
      }
      const tokenMint = req.query.tokenMint?.trim() || GAME_TOKEN_MINT;
      try {
        const { streams } = await op.tokens.streams(tokenMint);
        const filtered = (
          streams as Array<{
            holder: string;
            streamId: string;
            settled?: boolean;
            closed?: boolean;
            lockedTokenAmount?: string | null;
          }>
        ).filter((s) => s.holder === wallet && !s.settled && !s.closed);
        // Enrich with current effectiveBps so the picker can show "you hold X%
        // of this stream right now". N+1 cost is fine for a player's few streams.
        const enriched = await Promise.all(
          filtered.map(async (s) => {
            try {
              const ent = (await op.streams.entitlement(s.streamId, s.holder)) as {
                effectiveBps?: number;
                entitledLamports?: string;
              };
              return {
                holder: s.holder,
                streamId: s.streamId,
                effectiveBps: ent.effectiveBps ?? null,
                entitledLamports: ent.entitledLamports ?? "0",
                lockedTokenAmount: s.lockedTokenAmount ?? null,
              };
            } catch {
              return {
                holder: s.holder,
                streamId: s.streamId,
                effectiveBps: null,
                entitledLamports: "0",
                lockedTokenAmount: s.lockedTokenAmount ?? null,
              };
            }
          }),
        );
        return reply.send({ wallet, tokenMint, streams: enriched });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(503).send({
          error: { code: "RPC_DEGRADED", message: msg, fatal: false },
        });
      }
    },
  );

  app.get("/api/admin/sessions", async (_req, reply) => {
    if (config.HOST !== "127.0.0.1" && config.HOST !== "localhost") {
      return reply
        .code(403)
        .send({ error: { code: "FORBIDDEN", message: "admin only on localhost", fatal: true } });
    }
    const live = listLive().map((m) => m.snapshot());
    return reply.send({ count: live.length, sessions: live });
  });
}

/**
 * Look up both sides' lockedTokenAmount, derive the wager amount (creator's
 * intent if set, else stakeBps × min(locked) / 10000), and validate. Returns:
 *   - { kind: "ok", wager: WagerSnapshot } — full amount-based path
 *   - { kind: "ok", wager: null }          — legacy fallback (locked missing on either side)
 *   - { kind: "reject", code, message }    — cohort/floor/cap violation, surface to user
 */
async function tryMaterialiseWager(
  match: LiveMatch,
  joinerStreamId: string,
  /** Max bps each side may lose in its OWN stream: the router's unsold
   *  predicate (maxLossBps), not just the chunk-0 entry. */
  heldBps: { a: number; b: number },
): Promise<
  | { kind: "ok"; wager: WagerSnapshot | null }
  | { kind: "reject"; code: WagerError; message: string }
> {
  let lockedA: string | null = null;
  let lockedB: string | null = null;
  // Read both stream sizes, retrying a transient miss. We must distinguish a
  // FETCH FAILURE (couldn't read → retryable; do NOT silently downgrade to the
  // symmetric-bps path, which would bet a wrong amount) from a GENUINE null
  // lockedTokenAmount (orphan-backfilled legacy stream → bps path is correct).
  let fetchOk = false;
  for (let attempt = 1; attempt <= 3 && !fetchOk; attempt++) {
    try {
      const { streams } = (await op.tokens.streams(match.tokenMint)) as {
        streams: Array<{ streamId: string; lockedTokenAmount?: string | null }>;
      };
      lockedA =
        streams.find((s) => s.streamId === match.playerA.streamId)?.lockedTokenAmount ?? null;
      lockedB = streams.find((s) => s.streamId === joinerStreamId)?.lockedTokenAmount ?? null;
      fetchOk = true;
    } catch {
      if (attempt < 3) await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }

  if (!fetchOk) {
    // Couldn't read stream sizes after retries — reject (retryable) rather than
    // silently fall back to 10%-bps on a transient infra blip.
    return {
      kind: "reject",
      code: "STREAMS_UNAVAILABLE",
      message: "Couldn't read stream sizes right now — please try again in a moment.",
    };
  }

  if (lockedA == null || lockedB == null) {
    // Genuinely missing locked size (legacy/orphan-backfilled stream) — the
    // symmetric bpsAtStake path is the correct fallback here.
    return { kind: "ok", wager: null };
  }

  // Size against what each player can actually LOSE: their unsold share
  // (Option B: 1 bps = 1/10000 of the position; a holder who sold part of
  // their share can only stake the rest). lockedTokenAmount is the stream's
  // total, so h bps of it is locked × h / 10000. Sizing against the full locked amount
  // let a 10% holder be matched for more bps than they own, which the chain
  // rejects at apply time (DeltaUnderflow) after the match was played.
  const heldA = (BigInt(lockedA) * BigInt(heldBps.a)) / 10000n;
  const heldB = (BigInt(lockedB) * BigInt(heldBps.b)) / 10000n;

  // Pick amount: creator's intent if set, else derive from stakeBps. Then
  // clamp to min(heldA, heldB) so a creator who asked for more than the
  // joiner can absorb still gets a valid pairing (rather than a hard reject).
  const fromIntent = match.desiredWagerAmountRaw
    ? safeBigInt(match.desiredWagerAmountRaw)
    : null;
  const fromBps = amountFromStakeBps(match.bpsAtStake, heldA, heldB);
  const cap = heldA < heldB ? heldA : heldB;
  const desired = fromIntent ?? fromBps;
  const amount = desired < cap ? desired : cap;

  const result = materialiseWager({
    amountRaw: amount.toString(),
    stakeBps: match.bpsAtStake,
    lockedA,
    lockedB,
    cohortMaxRatio: config.COHORT_MAX_RATIO,
  });

  if (!result.ok) {
    return { kind: "reject", code: result.code, message: result.message };
  }
  // bpsForOutcome rounds UP, so re-check the exact per-outcome debit.
  if (result.snapshot.bpsIfALoses > heldBps.a || result.snapshot.bpsIfBLoses > heldBps.b) {
    return {
      kind: "reject",
      code: "AMOUNT_ABOVE_CAP",
      message: "That wager is more than one player holds of their stream.",
    };
  }
  return { kind: "ok", wager: result.snapshot };
}

function safeBigInt(s: string): bigint | null {
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}
