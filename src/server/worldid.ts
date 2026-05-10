/**
 * World ID — RP signing, proof verification, session cookies.
 *
 * Backbone of the optional sybil gate. The flow:
 *
 *   1. Client requests an RpContext for a wallet.
 *   2. We sign a fresh nonce with WORLD_SIGNING_KEY (server-only) and return it.
 *   3. Client opens IDKitRequestWidget with signal=wallet, gets a proof.
 *   4. Client posts proof + wallet here.
 *   5. We re-hash wallet → expect signal_hash to match (binds proof to wallet),
 *      then forward the proof byte-for-byte to /api/v4/verify/{rp_id}.
 *   6. On success, upsert (nullifier ↔ wallet) and set a signed cookie.
 *
 * The cookie is a self-contained HMAC-signed payload — no server-side session
 * lookup needed on every match-route call.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { signRequest } from "@worldcoin/idkit-core/signing";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { config } from "./config.js";
import { logger } from "./log.js";
import { getHumanByNullifier, getHumanByWallet, touchHuman, upsertHuman } from "./db.js";

const SESSION_TTL_SEC = 24 * 60 * 60;
export const SESSION_COOKIE = "wid_session";

export type SessionPayload = {
  nullifier: string;
  wallet: string;
  exp: number;
};

export type WorldIdContext = {
  app_id: string;
  rp_id: string;
  action: string;
  environment: "staging" | "production";
  nonce: string;
  created_at: number;
  expires_at: number;
  signature: string;
};

export class WorldIdNotConfiguredError extends Error {
  constructor() {
    super("World ID is not configured (missing WORLD_APP_ID / WORLD_RP_ID / WORLD_SIGNING_KEY / WORLD_SESSION_SECRET)");
  }
}

export function isWorldIdConfigured(): boolean {
  return !!(
    config.WORLD_APP_ID &&
    config.WORLD_RP_ID &&
    config.WORLD_SIGNING_KEY &&
    config.WORLD_SESSION_SECRET
  );
}

function requireConfigured(): {
  appId: string;
  rpId: string;
  signingKey: string;
  sessionSecret: string;
  action: string;
  environment: "staging" | "production";
} {
  if (!isWorldIdConfigured()) throw new WorldIdNotConfiguredError();
  return {
    appId: config.WORLD_APP_ID!,
    rpId: config.WORLD_RP_ID!,
    signingKey: config.WORLD_SIGNING_KEY!,
    sessionSecret: config.WORLD_SESSION_SECRET!,
    action: config.WORLD_ACTION,
    environment: config.WORLD_ENVIRONMENT,
  };
}

// ───────── RpContext signing ─────────

export function buildRpContext(): WorldIdContext {
  const cfg = requireConfigured();
  const sig = signRequest({ signingKeyHex: cfg.signingKey, action: cfg.action });
  return {
    app_id: cfg.appId,
    rp_id: cfg.rpId,
    action: cfg.action,
    environment: cfg.environment,
    nonce: sig.nonce,
    created_at: sig.createdAt,
    expires_at: sig.expiresAt,
    signature: sig.sig,
  };
}

// ───────── Proof verification ─────────

type VerifyResponse = {
  success: boolean;
  code?: string;
  detail?: string;
  message?: string;
  action?: string;
  nullifier?: string;
  results?: Array<{ identifier: string; success: boolean; nullifier?: string; code?: string }>;
};

/** Forward a proof to the developer-portal verify endpoint and pull the nullifier out. */
export async function verifyProofAtPortal(proof: unknown): Promise<{ ok: true; nullifier: string } | { ok: false; code: string; detail: string }> {
  const cfg = requireConfigured();
  const url = `https://developer.world.org/api/v4/verify/${cfg.rpId}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proof),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, code: "VERIFY_NETWORK", detail };
  }
  let body: VerifyResponse;
  try {
    body = (await res.json()) as VerifyResponse;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, code: "VERIFY_BAD_JSON", detail };
  }
  if (!res.ok || !body.success) {
    return {
      ok: false,
      code: body.code ?? `HTTP_${res.status}`,
      detail: body.detail ?? body.message ?? "verify failed",
    };
  }
  // Top-level nullifier is set on uniqueness proofs; legacy v3 puts it on the
  // first result entry. Try top-level first, then fall back.
  const nullifier = body.nullifier ?? body.results?.[0]?.nullifier;
  if (!nullifier) {
    return { ok: false, code: "VERIFY_NO_NULLIFIER", detail: "verify response missing nullifier" };
  }
  return { ok: true, nullifier };
}

/**
 * Pull the proof's signal_hash and confirm it matches hashSignal(wallet).
 * If the proof has no signal_hash field at all (uniqueness proof without a
 * signal), reject — verifiedOnly matches must be wallet-bound.
 */
export function proofMatchesWallet(proof: unknown, wallet: string): boolean {
  if (!proof || typeof proof !== "object") return false;
  const responses = (proof as { responses?: unknown }).responses;
  if (!Array.isArray(responses) || responses.length === 0) return false;
  const expected = hashSignal(wallet);
  for (const r of responses) {
    const sig = (r as { signal_hash?: unknown }).signal_hash;
    if (typeof sig !== "string") return false;
    if (sig.toLowerCase() !== expected.toLowerCase()) return false;
  }
  return true;
}

// ───────── Session cookie (HMAC-signed) ─────────
//
// Format: base64url(json({nullifier, wallet, exp})).hexHmac
// 24h TTL. Self-contained — no DB lookup per request.

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Buffer {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function hmac(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function signSession(payload: { nullifier: string; wallet: string }): {
  cookie: string;
  exp: number;
} {
  const cfg = requireConfigured();
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const inner: SessionPayload = { nullifier: payload.nullifier, wallet: payload.wallet, exp };
  const head = b64url(Buffer.from(JSON.stringify(inner)));
  const tag = hmac(head, cfg.sessionSecret);
  return { cookie: `${head}.${tag}`, exp };
}

export function verifySession(raw: string | undefined): SessionPayload | null {
  if (!raw) return null;
  if (!isWorldIdConfigured()) return null;
  const cfg = requireConfigured();
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return null;
  const head = raw.slice(0, dot);
  const tag = raw.slice(dot + 1);
  const expectedTag = hmac(head, cfg.sessionSecret);
  // Constant-time compare; bail if lengths differ to avoid throw from timingSafeEqual.
  const a = Buffer.from(tag);
  const b = Buffer.from(expectedTag);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(fromB64url(head).toString("utf8")) as SessionPayload;
  } catch {
    return null;
  }
  if (typeof payload.nullifier !== "string" || typeof payload.wallet !== "string" || typeof payload.exp !== "number") {
    return null;
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// ───────── Higher-level helpers ─────────

/** Run a fresh proof through verify + persist + return cookie material. */
export async function verifyAndBind(args: {
  proof: unknown;
  wallet: string;
}): Promise<
  | { ok: true; nullifier: string; cookie: string; exp: number }
  | { ok: false; code: string; detail: string }
> {
  const cfg = requireConfigured();
  if (!proofMatchesWallet(args.proof, args.wallet)) {
    return { ok: false, code: "SIGNAL_MISMATCH", detail: "proof signal does not match wallet" };
  }
  const result = await verifyProofAtPortal(args.proof);
  if (!result.ok) return result;
  upsertHuman({ nullifier: result.nullifier, wallet: args.wallet, action: cfg.action });
  const session = signSession({ nullifier: result.nullifier, wallet: args.wallet });
  logger.info(
    { wallet: args.wallet.slice(0, 8), nullifier: result.nullifier.slice(0, 10) },
    "worldid.verified",
  );
  return { ok: true, nullifier: result.nullifier, cookie: session.cookie, exp: session.exp };
}

/** Returns true iff the cookie corresponds to a current humans row mapping wallet. */
export function isWalletVerified(cookieRaw: string | undefined, wallet: string): boolean {
  const session = verifySession(cookieRaw);
  if (!session) return false;
  if (session.wallet !== wallet) return false;
  // Cross-check the DB so a deleted/rotated mapping invalidates immediately.
  const human = getHumanByNullifier(session.nullifier);
  if (!human || human.wallet !== wallet) return false;
  touchHuman(session.nullifier);
  return true;
}

export { getHumanByWallet, getHumanByNullifier };
