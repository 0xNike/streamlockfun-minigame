/**
 * Thin wrappers over the operator server's HTTP API.
 *
 * All requests go through Vite's dev proxy in dev (relative URLs); set
 * VITE_API_BASE for the deployed frontend → tunneled-operator setup.
 */

const BASE = import.meta.env.VITE_API_BASE ?? "";

async function asJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    const msg = (parsed as { error?: { message?: string } } | null)?.error?.message ?? text ?? `HTTP ${res.status}`;
    throw new Error(`${res.status}: ${msg}`);
  }
  return text ? JSON.parse(text) as T : (undefined as T);
}

export type StreamsResponse = {
  wallet: string;
  tokenMint: string;
  streams: {
    holder: string;
    streamId: string;
    effectiveBps: number | null;
    entitledLamports: string | null;
    lockedTokenAmount: string | null;
  }[];
};

export type CreateMatchResponse = { matchId: string; matchUrl: string; wsUrl: string };
export type JoinMatchResponse = { matchId: string; wsUrl: string };

export type ServerConfig = {
  tokenMint: string;
  tokenMeta: import("./types").TokenMetaPublic | null;
  stakeBps: number;
  disputeWindowSec: number;
  /** Cohort tolerance band: matchmaking rejects pairings where larger / smaller > this. */
  cohortMaxRatio: number;
  explorerCluster: "devnet" | "mainnet" | string;
  tokenEnv: "sol" | "soldev";
  /** Absolute WS origin for direct connection (bypasses Vercel's HTTP-only rewrite). */
  wsBase: string;
  /** World ID server config. `enabled: false` → don't show the verified-only toggle. */
  worldId:
    | {
        enabled: true;
        appId: string;
        action: string;
        environment: "staging" | "production";
      }
    | { enabled: false };
};

export type WorldIdMeResponse =
  | { verified: true; wallet: string; nullifier: string; exp: number }
  | { verified: false };

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

export const api = {
  async getConfig(): Promise<ServerConfig> {
    const res = await fetch(`${BASE}/api/config`);
    return asJson<ServerConfig>(res);
  },
  async getTokenMeta(mint: string): Promise<import("./types").TokenMetaPublic> {
    const res = await fetch(`${BASE}/api/tokens/${encodeURIComponent(mint)}`);
    return asJson<import("./types").TokenMetaPublic>(res);
  },
  async getMyStreams(wallet: string, tokenMint?: string): Promise<StreamsResponse> {
    const qp = new URLSearchParams({ wallet });
    if (tokenMint) qp.set("tokenMint", tokenMint);
    const res = await fetch(`${BASE}/api/streams?${qp.toString()}`);
    return asJson<StreamsResponse>(res);
  },
  async createMatch(args: {
    wallet: string;
    streamId: string;
    tokenMint?: string;
    /** Optional absolute wager (raw u64 base units as a decimal string).
     *  Server clamps to min(P1.locked, P2.locked) at B-join. */
    wagerAmountRaw?: string;
    /** Opt the match into the World ID sybil gate. Both creator and joiner
     *  need a valid wid_session cookie matching their wallet. */
    verifiedOnly?: boolean;
    /** Which game to create ("gomoku"). Defaults to RPS server-side when omitted. */
    gameId?: string;
  }): Promise<CreateMatchResponse> {
    const res = await fetch(`${BASE}/api/matches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
      credentials: "include",
    });
    return asJson<CreateMatchResponse>(res);
  },
  async joinMatch(matchId: string, wallet: string, streamId: string): Promise<JoinMatchResponse> {
    const res = await fetch(`${BASE}/api/matches/${encodeURIComponent(matchId)}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet, streamId }),
      credentials: "include",
    });
    return asJson<JoinMatchResponse>(res);
  },
  async getMatch(matchId: string) {
    const res = await fetch(`${BASE}/api/matches/${encodeURIComponent(matchId)}`);
    return asJson<import("./types.ts").MatchSnapshot>(res);
  },
  worldid: {
    async me(): Promise<WorldIdMeResponse> {
      const res = await fetch(`${BASE}/api/worldid/me`, { credentials: "include" });
      return asJson<WorldIdMeResponse>(res);
    },
    async context(wallet: string): Promise<WorldIdContext> {
      const res = await fetch(`${BASE}/api/worldid/context`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet }),
      });
      return asJson<WorldIdContext>(res);
    },
    async verify(wallet: string, proof: unknown): Promise<{ verified: true; wallet: string; nullifier: string; exp: number }> {
      const res = await fetch(`${BASE}/api/worldid/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet, proof }),
        credentials: "include",
      });
      return asJson(res);
    },
    async logout(): Promise<void> {
      await fetch(`${BASE}/api/worldid/logout`, {
        method: "POST",
        credentials: "include",
      });
    },
  },
};
