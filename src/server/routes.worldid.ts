/**
 * /api/worldid/* — RpContext minting, proof verification, session lifecycle.
 *
 * All routes return the standard { error: { code, message, fatal } } envelope on
 * failure to match the rest of the operator API.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  SESSION_COOKIE,
  buildRpContext,
  getHumanByWallet,
  isWorldIdConfigured,
  verifyAndBind,
  verifySession,
} from "./worldid.js";

const ContextBody = z.object({
  wallet: z.string().min(32).max(64),
});

const VerifyBody = z.object({
  wallet: z.string().min(32).max(64),
  // The proof envelope is forwarded verbatim to the developer-portal verify
  // endpoint, so we don't validate its shape here — only require an object.
  proof: z.record(z.unknown()),
});

function notConfiguredReply(reply: import("fastify").FastifyReply) {
  return reply.code(503).send({
    error: {
      code: "WORLDID_NOT_CONFIGURED",
      message: "World ID is not configured on this server",
      fatal: true,
    },
  });
}

export function registerWorldIdRoutes(app: FastifyInstance): void {
  app.get("/api/worldid/config", async () => ({
    enabled: isWorldIdConfigured(),
  }));

  app.post("/api/worldid/context", async (req, reply) => {
    if (!isWorldIdConfigured()) return notConfiguredReply(reply);
    const parsed = ContextBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "BAD_FRAME",
          message: parsed.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; "),
          fatal: true,
        },
      });
    }
    try {
      const ctx = buildRpContext();
      return reply.send(ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.error({ err: msg }, "worldid.context_failed");
      return reply.code(500).send({
        error: { code: "INTERNAL", message: msg, fatal: true },
      });
    }
  });

  app.post("/api/worldid/verify", async (req, reply) => {
    if (!isWorldIdConfigured()) return notConfiguredReply(reply);
    const parsed = VerifyBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "BAD_FRAME",
          message: parsed.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; "),
          fatal: true,
        },
      });
    }
    const { wallet, proof } = parsed.data;
    const result = await verifyAndBind({ proof, wallet });
    if (!result.ok) {
      return reply.code(400).send({
        error: { code: result.code, message: result.detail, fatal: true },
      });
    }
    reply.setCookie(SESSION_COOKIE, result.cookie, {
      httpOnly: true,
      sameSite: "lax",
      // secure cookies require HTTPS — keep off in dev so localhost works.
      secure: process.env.NODE_ENV === "production",
      path: "/",
      expires: new Date(result.exp * 1000),
    });
    return reply.send({
      verified: true,
      wallet,
      nullifier: result.nullifier,
      exp: result.exp,
    });
  });

  app.get("/api/worldid/me", async (req, reply) => {
    const cookie = req.cookies?.[SESSION_COOKIE];
    const session = verifySession(cookie);
    if (!session) return reply.send({ verified: false });
    // Cross-check DB so a rotated/cleared mapping shows up as unverified.
    const human = getHumanByWallet(session.wallet);
    if (!human || human.nullifier !== session.nullifier) {
      return reply.send({ verified: false });
    }
    return reply.send({
      verified: true,
      wallet: session.wallet,
      nullifier: session.nullifier,
      exp: session.exp,
    });
  });

  app.post("/api/worldid/logout", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.send({ ok: true });
  });
}
