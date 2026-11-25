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

// Challenges are keyed by their random nonce, so a request for someone else's
// wallet can't overwrite theirs. Each is single use (consumed on verify).
const challenges = new Map<string, { wallet: string; message: string; exp: number }>();
const MAX_CHALLENGES_PER_WALLET = 5;
const MAX_CHALLENGES_TOTAL = 50_000;
// Per-IP nonce rate limit (fixed 1-minute window).
const NONCE_PER_IP_PER_MIN = 20;
const nonceHits = new Map<string, { windowStart: number; count: number }>();

function rateLimited(ip: string): boolean {
  const t = nowSec();
  const h = nonceHits.get(ip);
  if (!h || t - h.windowStart >= 60) {
    nonceHits.set(ip, { windowStart: t, count: 1 });
    return false;
  }
  h.count += 1;
  return h.count > NONCE_PER_IP_PER_MIN;
}

function addChallenge(nonce: string, wallet: string, message: string, exp: number): void {
  // Keep only the newest few per wallet (Map preserves insertion order).
  const mine = [...challenges].filter(([, c]) => c.wallet === wallet);
  for (const [n] of mine.slice(0, Math.max(0, mine.length - (MAX_CHALLENGES_PER_WALLET - 1)))) {
    challenges.delete(n);
  }
  challenges.set(nonce, { wallet, message, exp });
}

const NONCE_RE = /^Nonce: ([0-9a-f]{32})$/m;

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
    if (rateLimited(req.ip) || challenges.size >= MAX_CHALLENGES_TOTAL) {
      return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "too many sign-in attempts; wait a minute", fatal: false } });
    }
    const issuedAt = nowSec();
    const nonce = randomBytes(16).toString("hex");
    const message = challengeMessage(wallet, nonce, issuedAt);
    addChallenge(nonce, wallet, message, issuedAt + NONCE_TTL_SEC);
    return reply.send({ message, expiresAt: issuedAt + NONCE_TTL_SEC });
  });

  app.post("/api/auth/verify", async (req, reply) => {
    const parsed = VerifyBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "BAD_FRAME", message: "bad verify body", fatal: true } });
    }
    const { wallet, message, signature } = parsed.data;
    const nonce = NONCE_RE.exec(message)?.[1];
    const ch = nonce ? challenges.get(nonce) : undefined;
    if (!ch || ch.wallet !== wallet || ch.exp < nowSec() || ch.message !== message) {
      return reply.code(401).send({
        error: { code: "AUTH_REQUIRED", message: "sign-in challenge expired; please try again", fatal: true },
      });
    }
    challenges.delete(nonce!); // single use
    if (!verifyEd25519(wallet, message, Buffer.from(signature, "base64"))) {
      return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "signature did not verify", fatal: true } });
    }
    const { token, exp } = issueToken(wallet);
    return reply.send({ token, wallet, exp });
  });

  // Drop stale challenges so the map can't grow unbounded.
  setInterval(() => {
    const t = nowSec();
    for (const [n, c] of challenges) if (c.exp < t) challenges.delete(n);
    for (const [ip, h] of nonceHits) if (t - h.windowStart >= 60) nonceHits.delete(ip);
  }, 60_000).unref();
}
