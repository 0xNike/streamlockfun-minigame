/**
 * Token metadata fetch via Solana JSON-RPC `getAsset` (Helius DAS-compatible).
 *
 * In-memory cache, never throws — failures resolve to a stub with null fields
 * so callers can still render the mint address.
 */

import { logger } from "./log.js";

export interface TokenMeta {
  mint: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  imageUri: string | null;
}

const cache = new Map<string, TokenMeta>();
const inflight = new Map<string, Promise<TokenMeta>>();

function rpcUrl(): string | null {
  return process.env.SOLANA_RPC_URL ?? null;
}

function stub(mint: string): TokenMeta {
  return { mint, name: null, symbol: null, decimals: null, imageUri: null };
}

export async function getTokenMeta(mint: string): Promise<TokenMeta> {
  const cached = cache.get(mint);
  if (cached) return cached;
  const pending = inflight.get(mint);
  if (pending) return pending;

  const url = rpcUrl();
  if (!url) {
    const s = stub(mint);
    cache.set(mint, s);
    return s;
  }

  const promise = (async () => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          method: "getAsset",
          params: { id: mint },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as {
        error?: { message?: string };
        result?: {
          content?: {
            metadata?: { name?: string; symbol?: string };
            links?: { image?: string };
          };
          token_info?: { decimals?: number };
        };
      };
      if (j.error) throw new Error(j.error.message ?? "rpc error");
      const meta: TokenMeta = {
        mint,
        name: j.result?.content?.metadata?.name?.trim() || null,
        symbol: j.result?.content?.metadata?.symbol?.trim() || null,
        decimals: j.result?.token_info?.decimals ?? null,
        imageUri: j.result?.content?.links?.image ?? null,
      };
      cache.set(mint, meta);
      logger.info({ mint, name: meta.name, symbol: meta.symbol }, "tokenmeta.cached");
      return meta;
    } catch (err) {
      logger.warn(
        { mint, err: err instanceof Error ? err.message : String(err) },
        "tokenmeta.fetch_failed",
      );
      const s = stub(mint);
      cache.set(mint, s);
      return s;
    } finally {
      inflight.delete(mint);
    }
  })();
  inflight.set(mint, promise);
  return promise;
}

/** Synchronous read, returns cached entry only. */
export function peekTokenMeta(mint: string): TokenMeta | null {
  return cache.get(mint) ?? null;
}
