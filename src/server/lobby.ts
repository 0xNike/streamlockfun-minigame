/**
 * Games Lobby mirror — emits this repo's match lifecycle to the operator's
 * per-token lobby via `op.lobby.*` (SDK v0.1.7, off-chain, API-key-authed).
 *
 * The lobby is a DISPLAY MIRROR, not the source of truth. Every call here is
 * best-effort: wrapped in try/catch, fire-and-forget from the match flow, and
 * MUST NEVER block or fail a match. If the operator API is down or the listing
 * is gone, we log and move on.
 *
 * Contract (Phase 1 handoff): matchId == listingId (idempotent across the
 * lifecycle); the public /match/:id URL is the Join/View redirect target.
 */

import type { UpdateLobbyListingRequest } from "@streamlock/operator-sdk";
import { op } from "../operator.js";
import { config } from "./config.js";
import { getGame } from "./games/registry.js";
import { logger } from "./log.js";
import { getTokenMeta } from "./tokenmeta.js";

const log = logger.child({ mod: "lobby" });

/** Fallback when token metadata can't be read in time (devnet $LOCK = 6). */
const DECIMALS_FALLBACK = 6;
/** How long an unfilled (WaitingForPlayers) listing lingers before the lobby TTL drops it. */
const LISTING_TTL_SEC = 15 * 60;

const nowSec = () => Math.floor(Date.now() / 1000);
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Join/View target — same shape as routes.matches.ts `matchUrl`. */
const gameUrl = (matchId: string) => `${config.PUBLIC_BASE_URL}/match/${matchId}`;

/**
 * List a match at create time (player A seated, WaitingForPlayers). Caller must
 * only invoke this for lobby-eligible matches (wager fixed at create — see the
 * Phase 1 decision); a match without a create-time wager is simply not listed.
 */
export async function createListing(args: {
  matchId: string;
  /** Internal game id ("rps"); resolved to the lobby slug + name via the registry. */
  gameId: string;
  tokenMint: string;
  /** u64 base units, decimal string. */
  wagerAmountRaw: string;
  playerSlots?: number;
  playersJoined?: number;
}): Promise<void> {
  try {
    const def = getGame(args.gameId);
    const meta = await getTokenMeta(args.tokenMint).catch(() => null);
    await op.lobby.create({
      listingId: args.matchId,
      tokenAddress: args.tokenMint,
      gameId: def.slug ?? def.id,
      gameName: def.title,
      gameUrl: gameUrl(args.matchId),
      playerSlots: args.playerSlots ?? 2,
      playersJoined: args.playersJoined ?? 1,
      wagerTokenAmount: args.wagerAmountRaw,
      wagerTokenDecimals: meta?.decimals ?? DECIMALS_FALLBACK,
      wagerTokenSymbol: meta?.symbol ?? undefined,
      expiresAt: nowSec() + LISTING_TTL_SEC,
    });
    log.info({ matchId: args.matchId, gameId: def.slug ?? def.id }, "lobby.create");
  } catch (err) {
    log.warn({ matchId: args.matchId, err: errMsg(err) }, "lobby.create_failed");
  }
}

export async function updateListing(matchId: string, patch: UpdateLobbyListingRequest): Promise<void> {
  try {
    await op.lobby.update(matchId, patch);
    log.info({ matchId, patch }, "lobby.update");
  } catch (err) {
    log.warn({ matchId, err: errMsg(err) }, "lobby.update_failed");
  }
}

export async function closeListing(
  matchId: string,
  status: "Cancelled" | "Finalized" | "Expired" = "Cancelled",
): Promise<void> {
  try {
    await op.lobby.close(matchId, status);
    log.info({ matchId, status }, "lobby.close");
  } catch (err) {
    log.warn({ matchId, err: errMsg(err) }, "lobby.close_failed");
  }
}
