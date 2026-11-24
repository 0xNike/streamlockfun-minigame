/**
 * Wallet sign-in: prove control of a Solana wallet by signing a one-time
 * message, then carry a short-lived HMAC token.
 *
 *   POST /api/auth/nonce  { wallet }                      → { message, expiresAt }
 *   POST /api/auth/verify { wallet, message, signature }  → { token, wallet, exp }
 *
 * The token is sent as `Authorization: Bearer <token>` on create/join and as
 * `?token=` on the match WebSocket (browsers can't set WS headers, and a
 * cross-site cookie on the Fly host would be blocked by third-party-cookie
 * rules). Every staked action is bound to the wallet in the token.
 */

import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { logger } from "./log.js";

const NONCE_TTL_SEC = 5 * 60;
const TOKEN_TTL_SEC = 12 * 60 * 60;

const SECRET: Buffer = (() => {
  if (config.AUTH_SESSION_SECRET) return Buffer.from(config.AUTH_SESSION_SECRET);
  if (config.NODE_ENV === "production") {
    throw new Error("AUTH_SESSION_SECRET is required in production");
  }
  logger.warn("auth.dev_secret AUTH_SESSION_SECRET unset; using a random per-process secret");
  return randomBytes(32);
})();

const nowSec = () => Math.floor(Date.now() / 1000);

// One outstanding challenge per wallet; consumed on verify.
const challenges = new Map<string, { message: string; exp: number }>();

function challengeMessage(wallet: string, nonce: string, issuedAt: number): string {
  return [
    "Sign in to Streamlock Games",
    "",
    "This proves you control this wallet. It does not move funds or cost anything.",
    "",
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
    `Issued: ${new Date(issuedAt * 1000).toISOString()}`,
    `Server: ${config.PUBLIC_BASE_URL}`,
  ].join("\n");
}

// ed25519 SPKI DER prefix; append the 32-byte raw public key.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function verifyEd25519(wallet: string, message: string, signature: Buffer): boolean {
  try {
    const raw = new PublicKey(wallet).toBuffer();
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
    return verify(null, Buffer.from(message, "utf8"), key, signature);
  } catch {
    return false;
  }
}

function sign(payload: string): string {
  return createHmac("sha256", SECRET).update(payload).digest("base64url");
}

export function issueToken(wallet: string): { token: string; exp: number } {
  const exp = nowSec() + TOKEN_TTL_SEC;
  const payload = Buffer.from(JSON.stringify({ w: wallet, exp })).toString("base64url");
  return { token: `${payload}.${sign(payload)}`, exp };
}

/** Returns the wallet the token was issued for, or null if invalid/expired. */
export function walletFromToken(token: string | undefined | null): string | null {
  if (!token) return null;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const expected = Buffer.from(sign(payload));
  const got = Buffer.from(mac);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  try {
    const { w, exp } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { w: string; exp: number };
    if (typeof w !== "string" || typeof exp !== "number" || exp < nowSec()) return null;
    return w;
  } catch {
    return null;
  }
}

/** Wallet from `Authorization: Bearer <token>`, or null. */
export function authedWallet(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return null;
  return walletFromToken(h.slice(7).trim());
}

const NonceBody = z.object({ wallet: z.string().min(32).max(64) });
const VerifyBody = z.object({
  wallet: z.string().min(32).max(64),
  message: z.string().min(1).max(1000),
  signature: z.string().min(1).max(200), // base64
});

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post("/api/auth/nonce", async (req, reply) => {
    const parsed = NonceBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "BAD_FRAME", message: "missing wallet", fatal: true } });
    }
    const { wallet } = parsed.data;
    try {
      new PublicKey(wallet);
    } catch {
      return reply.code(400).send({ error: { code: "BAD_FRAME", message: "invalid wallet", fatal: true } });
    }
    const issuedAt = nowSec();
    const message = challengeMessage(wallet, randomBytes(16).toString("hex"), issuedAt);
    challenges.set(wallet, { message, exp: issuedAt + NONCE_TTL_SEC });
    return reply.send({ message, expiresAt: issuedAt + NONCE_TTL_SEC });
  });

  app.post("/api/auth/verify", async (req, reply) => {
    const parsed = VerifyBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "BAD_FRAME", message: "bad verify body", fatal: true } });
    }
    const { wallet, message, signature } = parsed.data;
    const ch = challenges.get(wallet);
    if (!ch || ch.exp < nowSec() || ch.message !== message) {
      return reply.code(401).send({
        error: { code: "AUTH_REQUIRED", message: "sign-in challenge expired; please try again", fatal: true },
      });
    }
    challenges.delete(wallet); // single use
    if (!verifyEd25519(wallet, message, Buffer.from(signature, "base64"))) {
      return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "signature did not verify", fatal: true } });
    }
    const { token, exp } = issueToken(wallet);
    return reply.send({ token, wallet, exp });
  });

  // Drop stale challenges so the map can't grow unbounded.
  setInterval(() => {
    const t = nowSec();
    for (const [w, c] of challenges) if (c.exp < t) challenges.delete(w);
  }, 60_000).unref();
}
