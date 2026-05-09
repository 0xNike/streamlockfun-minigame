/**
 * Real HTTP handlers for /api/matches/*.
 *
 * Validates inputs with zod, never throws raw — every error path returns the
 * { error: { code, message, fatal } } envelope from the contract.
 */

import type { FastifyInstance } from "fastify";
import { op, GAME_TOKEN_MINT } from "../operator.js";
import { config } from "./config.js";
import { listLive, getLive, createLiveMatch } from "./matches.js";
import { getTokenMeta } from "./tokenmeta.js";
import {
  CreateMatchBody,
  JoinMatchBody,
  type CreateMatchResponse,
  type JoinMatchResponse,
} from "./types.js";

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
    const match = createLiveMatch({
      tokenMint: body.tokenMint ?? GAME_TOKEN_MINT,
      playerAWallet: body.wallet,
      playerAStream: body.streamId,
      bpsAtStake: body.bpsAtStake ?? config.STAKE_BPS,
      disputeWindowSec: config.DISPUTE_WINDOW_SEC,
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
    try {
      match.joinAsB(parsed.data.wallet, parsed.data.streamId);
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
    explorerCluster: config.TOKEN_ENV === "sol" ? "mainnet" : "devnet",
    tokenEnv: config.TOKEN_ENV,
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
