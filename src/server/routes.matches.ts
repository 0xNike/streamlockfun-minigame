/**
 * Real HTTP handlers for /api/matches/*.
 *
 * Validates inputs with zod, never throws raw — every error path returns the
 * { error: { code, message, fatal } } envelope from the contract.
 */

import type { FastifyInstance } from "fastify";
import { op, GAME_TOKEN_MINT } from "../operator.js";
import { config } from "./config.js";
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

function wsUrl(matchId: string, side: "a" | "b"): string {
  return `${config.PUBLIC_WS_URL}/ws/match/${matchId}?as=${side}`;
}

function matchUrl(matchId: string): string {
  return `${config.PUBLIC_BASE_URL}/match/${matchId}`;
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
      tokenMint: body.tokenMint ?? GAME_TOKEN_MINT,
      playerAWallet: body.wallet,
      playerAStream: body.streamId,
      bpsAtStake: body.bpsAtStake ?? config.STAKE_BPS,
      disputeWindowSec: config.DISPUTE_WINDOW_SEC,
      desiredWagerAmountRaw: body.wagerAmountRaw,
      verifiedOnly: body.verifiedOnly,
      creatorNullifier,
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
    const wagerOrErr = await tryMaterialiseWager(match, parsed.data.streamId);
    if (wagerOrErr.kind === "reject") {
      return reply.code(422).send({
        error: { code: wagerOrErr.code, message: wagerOrErr.message, fatal: true },
      });
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
    disputeWindowSec: config.DISPUTE_WINDOW_SEC,
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
): Promise<
  | { kind: "ok"; wager: WagerSnapshot | null }
  | { kind: "reject"; code: WagerError; message: string }
> {
  let lockedA: string | null = null;
  let lockedB: string | null = null;
  try {
    const { streams } = (await op.tokens.streams(match.tokenMint)) as {
      streams: Array<{ streamId: string; lockedTokenAmount?: string | null }>;
    };
    lockedA =
      streams.find((s) => s.streamId === match.playerA.streamId)?.lockedTokenAmount ?? null;
    lockedB = streams.find((s) => s.streamId === joinerStreamId)?.lockedTokenAmount ?? null;
  } catch {
    // SDK transient — fall through to legacy path so the join doesn't fail
    // for an infrastructure blip. Settlement will still work via bpsAtStake.
  }

  if (lockedA == null || lockedB == null) {
    return { kind: "ok", wager: null };
  }

  // Pick amount: creator's intent if set, else derive from stakeBps. Then
  // clamp to min(lockedA, lockedB) so a creator who asked for more than the
  // joiner can absorb still gets a valid pairing (rather than a hard reject).
  const fromIntent = match.desiredWagerAmountRaw
    ? safeBigInt(match.desiredWagerAmountRaw)
    : null;
  const fromBps = amountFromStakeBps(match.bpsAtStake, BigInt(lockedA), BigInt(lockedB));
  const cap = BigInt(lockedA) < BigInt(lockedB) ? BigInt(lockedA) : BigInt(lockedB);
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
  return { kind: "ok", wager: result.snapshot };
}

function safeBigInt(s: string): bigint | null {
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}
