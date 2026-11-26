/**
 * Direct, read-only chain reads against streamlock_router.
 *
 * Why this exists: since the 2026-11 router fix, `apply_delta_to_ledger` fails
 * AFTER a match has been played if any of these hold. The player sees "match
 * played, payout failed":
 *   - DisputeWindowTooShort: create rejects dispute_end_ts - end_ts < max(config, 3600)
 *   - ChunkFull:            a stream's entitlement chunk 0 holds ≤ max_entitlement_entries_per_chunk (50)
 *   - DeltaUnderflow:       a negative delta larger than the holder's own bps
 *   - LedgerHasProceeds:    any proceeds on the ledger freeze it
 *   - settled / mint mismatch
 * Reading the same accounts at create/join lets us refuse the match up front.
 *
 * The shared layouts below (config, ledger, chunk, session) mirror the mainnet
 * IDL (2atKseCg…, 2026-11-24) and are identical on devnet. The Option B
 * accounts further down exist only on the devnet router for now. Every
 * account starts with an 8-byte Anchor discriminator.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "./config.js";

const ROUTER_PROGRAM_IDS: Record<"sol" | "soldev", string> = {
  sol: "2atKseCgCRxwPnne67FwwDdTzdx7L3PveyHhzR6NgzmL",
  soldev: "8jX8rxpspTcWGPifKSJB9JdQsh6AhfGCazENnCyQA4sY",
};

/** Program floor, independent of config. */
export const MIN_DISPUTE_WINDOW_SEC = 3600;

export const ROUTER_PROGRAM_ID = new PublicKey(
  process.env.ROUTER_PROGRAM_ID ?? ROUTER_PROGRAM_IDS[config.TOKEN_ENV],
);

let conn: Connection | null = null;
function connection(): Connection {
  if (!conn) {
    const url = process.env.SOLANA_RPC_URL;
    if (!url) throw new Error("SOLANA_RPC_URL is not set");
    conn = new Connection(url, "confirmed");
  }
  return conn;
}

function hexToBytes(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`streamId must be 64 hex chars: ${hex}`);
  return Buffer.from(hex, "hex");
}

const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, ROUTER_PROGRAM_ID)[0];
export const configPda = () => pda([Buffer.from("streamlock_config")]);
export const ledgerPda = (streamIdHex: string) =>
  pda([Buffer.from("entitlement_ledger"), hexToBytes(streamIdHex)]);
export const entitlementChunk0Pda = (streamIdHex: string) =>
  pda([Buffer.from("entitlement_chunk"), hexToBytes(streamIdHex), Buffer.from([0, 0])]);

// ───────── StreamlockConfig ─────────

export interface RouterConfig {
  disputeWindowSeconds: number;
  maxEntitlementEntriesPerChunk: number;
}

// bump u8 | authority 32 | protocol_wallet 32 | settlement_fee_bps u16 | dispute_window_seconds i64 | max_entitlement_entries_per_chunk u16
const CFG_DISPUTE_OFF = 8 + 1 + 32 + 32 + 2;
const CFG_TTL_MS = 5 * 60_000;
let cfgCache: { at: number; value: RouterConfig } | null = null;

export async function readRouterConfig(): Promise<RouterConfig> {
  if (cfgCache && Date.now() - cfgCache.at < CFG_TTL_MS) return cfgCache.value;
  const info = await connection().getAccountInfo(configPda(), "confirmed");
  if (!info) throw new Error(`StreamlockConfig ${configPda().toBase58()} not found`);
  const value = {
    disputeWindowSeconds: Number(info.data.readBigInt64LE(CFG_DISPUTE_OFF)),
    maxEntitlementEntriesPerChunk: info.data.readUInt16LE(CFG_DISPUTE_OFF + 8),
  };
  cfgCache = { at: Date.now(), value };
  return value;
}

/**
 * Dispute window the router will accept: max(requested, config, 3600).
 * Read from chain (cached 5 min). Never hardcode: mainnet config is 86400.
 */
export async function effectiveDisputeWindowSec(requestedSec: number): Promise<number> {
  const { disputeWindowSeconds } = await readRouterConfig();
  return Math.max(requestedSec, disputeWindowSeconds, MIN_DISPUTE_WINDOW_SEC);
}

// ───────── EntitlementLedger + chunk 0 ─────────

export interface StreamChainState {
  streamId: string;
  ledgerExists: boolean;
  owner: string | null;
  tokenMint: string | null;
  settled: boolean;
  proceedsTotal: bigint;
  /** Chunk-0 entries (the only chunk apply_delta writes). */
  entries: { holder: string; bps: number }[];
}

// Ledger: bump u8 | vault_bump u8 | stream_id 32 | owner 32 | token_mint 32 | total_chunks u16 | settled bool | proceeds_total u64
const L_OWNER = 8 + 2 + 32;
const L_MINT = L_OWNER + 32;
const L_SETTLED = L_MINT + 32 + 2;
const L_PROCEEDS = L_SETTLED + 1;
// Chunk: bump u8 | stream_id 32 | chunk_index u16 | entries vec<{holder 32, bps u16}>
const C_VEC = 8 + 1 + 32 + 2;
const ENTRY_SIZE = 34;

export async function readStreamStates(streamIds: string[]): Promise<StreamChainState[]> {
  const keys = streamIds.flatMap((s) => [ledgerPda(s), entitlementChunk0Pda(s)]);
  const infos = await connection().getMultipleAccountsInfo(keys, "confirmed");
  return streamIds.map((streamId, i) => {
    const ledger = infos[2 * i];
    const chunk = infos[2 * i + 1];
    const entries: { holder: string; bps: number }[] = [];
    if (chunk) {
      const n = chunk.data.readUInt32LE(C_VEC);
      for (let k = 0; k < n; k++) {
        const off = C_VEC + 4 + k * ENTRY_SIZE;
        entries.push({
          holder: new PublicKey(chunk.data.subarray(off, off + 32)).toBase58(),
          bps: chunk.data.readUInt16LE(off + 32),
        });
      }
    }
    if (!ledger) {
      return { streamId, ledgerExists: false, owner: null, tokenMint: null, settled: false, proceedsTotal: 0n, entries };
    }
    const d = ledger.data;
    return {
      streamId,
      ledgerExists: true,
      owner: new PublicKey(d.subarray(L_OWNER, L_OWNER + 32)).toBase58(),
      tokenMint: new PublicKey(d.subarray(L_MINT, L_MINT + 32)).toBase58(),
      settled: d[L_SETTLED] === 1,
      proceedsTotal: d.readBigUInt64LE(L_PROCEEDS),
      entries,
    };
  });
}

export function holderBps(state: StreamChainState, wallet: string): number {
  return state.entries.find((e) => e.holder === wallet)?.bps ?? 0;
}

export type StakeGuardCode =
  | "STREAM_NO_LEDGER"
  | "STREAM_SETTLED"
  | "STREAM_HAS_PROCEEDS"
  | "STREAM_WRONG_MINT"
  | "STREAM_NO_SHARE"
  | "STREAM_HOLDERS_FULL";

/**
 * Per-stream eligibility for staking `wallet`'s share against `opponent`.
 * If `wallet` loses, `opponent` is credited inside this stream, so the stream
 * needs room for one more chunk-0 entry unless the opponent is already a holder.
 * Returns null when OK.
 */
export function stakeGuard(args: {
  state: StreamChainState;
  wallet: string;
  opponent: string | null;
  tokenMint: string;
  maxEntries: number;
}): { code: StakeGuardCode; message: string } | null {
  const { state, wallet, opponent, tokenMint, maxEntries } = args;
  if (!state.ledgerExists) {
    return { code: "STREAM_NO_LEDGER", message: "This stream has no entitlement ledger on-chain yet, so it can't be staked." };
  }
  if (state.settled) {
    return { code: "STREAM_SETTLED", message: "This stream is already settled and can't be staked." };
  }
  if (state.proceedsTotal > 0n) {
    return { code: "STREAM_HAS_PROCEEDS", message: "This stream has already been sold (it has proceeds), so its shares are frozen." };
  }
  if (state.tokenMint !== tokenMint) {
    return { code: "STREAM_WRONG_MINT", message: "This stream is for a different token than this game." };
  }
  if (holderBps(state, wallet) <= 0) {
    return { code: "STREAM_NO_SHARE", message: "You hold 0% of this stream on-chain, so there's nothing to stake." };
  }
  if (opponent && !state.entries.some((e) => e.holder === opponent) && state.entries.length >= maxEntries) {
    return {
      code: "STREAM_HOLDERS_FULL",
      message: `This stream already has ${state.entries.length} holders (the on-chain max is ${maxEntries}), so a new winner couldn't be paid from it.`,
    };
  }
  return null;
}

// ───────── Option B: HolderSale / ShareState / RouterParams / GameSession ─────────
// Layouts per spec §11 and the on-chain devnet IDL (router 8jX8…, 31 ixs, 2026-11-25).

export const holderSalePda = (streamIdHex: string, holder: string) =>
  pda([Buffer.from("holder_sale"), hexToBytes(streamIdHex), new PublicKey(holder).toBuffer()]);
export const shareStatePda = (streamIdHex: string) =>
  pda([Buffer.from("share_state"), hexToBytes(streamIdHex)]);
export const routerParamsPda = () => pda([Buffer.from("router_params")]);
export const routerRolePda = (key: PublicKey) => pda([Buffer.from("router_role"), key.toBuffer()]);
export const disputeRecordPda = (session: PublicKey, disputer: PublicKey) =>
  pda([Buffer.from("dispute"), session.toBuffer(), disputer.toBuffer()]);

export interface HolderSaleState {
  sold: bigint;
  reservedBps: number;
  reservedSession: string | null; // null = none (default pubkey)
  reservedUntil: number;
}

/** HolderSale (171 B): sold u64@73, reserved_bps u16@89, reserved_session@91, reserved_until i64@123. */
function decodeHolderSale(d: Buffer): HolderSaleState {
  const session = new PublicKey(d.subarray(91, 123));
  return {
    sold: d.readBigUInt64LE(73),
    reservedBps: d.readUInt16LE(89),
    reservedSession: session.equals(PublicKey.default) ? null : session.toBase58(),
    reservedUntil: Number(d.readBigInt64LE(123)),
  };
}

export interface RouterParams {
  minEntryBps: number;
  stakeLockGraceSecs: number;
}

let paramsCache: { at: number; value: RouterParams } | null = null;

/** RouterParams (59 B): min_entry_bps u16@9, stake_lock_grace_secs i64@11. */
export async function readRouterParams(): Promise<RouterParams> {
  if (paramsCache && Date.now() - paramsCache.at < CFG_TTL_MS) return paramsCache.value;
  const info = await connection().getAccountInfo(routerParamsPda(), "confirmed");
  if (!info) throw new Error(`RouterParams ${routerParamsPda().toBase58()} not found (router not initialised for Option B)`);
  const value = {
    minEntryBps: info.data.readUInt16LE(9),
    stakeLockGraceSecs: Number(info.data.readBigInt64LE(11)),
  };
  paramsCache = { at: Date.now(), value };
  return value;
}

export interface StakeView {
  /** Holder's chunk-0 bps. */
  bps: number;
  /** HolderSale, or null when the PDA doesn't exist (nothing sold, nothing reserved). */
  sale: HolderSaleState | null;
  /** E_snap = withdrawn_seen − pooled_sold, or null when ShareState doesn't exist. */
  eSnap: bigint | null;
}

/** Read what's needed to size a stake: HolderSale per holder + the stream's ShareState. */
export async function readStakeViews(
  items: { streamId: string; holder: string; bps: number }[],
): Promise<StakeView[]> {
  const keys = items.flatMap((it) => [holderSalePda(it.streamId, it.holder), shareStatePda(it.streamId)]);
  const infos = await connection().getMultipleAccountsInfo(keys, "confirmed");
  return items.map((it, i) => {
    const sale = infos[2 * i];
    const share = infos[2 * i + 1];
    // ShareState (65 B): pooled_sold u64@41, withdrawn_seen u64@49.
    const eSnap = share ? share.data.readBigUInt64LE(49) - share.data.readBigUInt64LE(41) : null;
    return { bps: it.bps, sale: sale ? decodeHolderSale(sale.data) : null, eSnap };
  });
}

/**
 * Largest loss (bps of the stream) the router will let this holder take, i.e.
 * the exact predicate apply_delta / reserve_stake enforce (spec §4.4):
 *   max d ≤ bps with floor((bps − d) · E_snap / 1e4) ≥ sold.
 * No ShareState or nothing sold → the whole share is at stake.
 */
export function maxLossBps(v: StakeView): number {
  const sold = v.sale?.sold ?? 0n;
  if (v.eSnap === null || sold === 0n) return v.bps;
  const e = v.eSnap;
  if (e <= 0n) return 0; // sold > 0 but nothing withdrawn: can't keep enough → no loss allowed
  // Smallest k with floor(k·E/1e4) ≥ sold  ⇔  k·E ≥ sold·1e4  ⇔  k = ceil(sold·1e4 / E).
  const keep = Number((sold * 10000n + e - 1n) / e);
  return Math.max(0, v.bps - keep);
}

/** A reservation still bound to some session blocks a new one (StakeAlreadyReserved). */
export function hasActiveReservation(v: StakeView): boolean {
  return !!v.sale && v.sale.reservedSession !== null && v.sale.reservedBps > 0;
}

/**
 * Router min-entry rule after apply: every CHANGED entry ends at 0 or ≥ min.
 * Loser keeps `loserBps − loss`; winner ends at `winnerExistingBps + loss`.
 */
export function minEntryViolation(args: {
  loserBps: number;
  winnerExistingBps: number;
  loss: number;
  minEntryBps: number;
}): string | null {
  const { loserBps, winnerExistingBps, loss, minEntryBps } = args;
  if (loss <= 0) return null;
  const rest = loserBps - loss;
  if (rest > 0 && rest < minEntryBps) {
    return `the loser would be left with ${rest} bps (the on-chain minimum is ${minEntryBps}, or exactly 0)`;
  }
  if (winnerExistingBps + loss < minEntryBps) {
    return `the winner would end with ${winnerExistingBps + loss} bps (the on-chain minimum is ${minEntryBps})`;
  }
  return null;
}

export type SessionStatus = "Open" | "Submitted" | "Finalized" | "Cancelled";

export interface SessionChainState {
  status: SessionStatus;
  hasDispute: boolean;
  disputeEndTs: number;
  startTs: number;
}

/** GameSession: start_ts@105, dispute_end_ts@121, status u8@129, has_dispute bool@166. */
export async function readSession(sessionPda: string): Promise<SessionChainState | null> {
  const info = await connection().getAccountInfo(new PublicKey(sessionPda), "confirmed");
  if (!info) return null;
  const d = info.data;
  return {
    status: (["Open", "Submitted", "Finalized", "Cancelled"] as const)[d[129]] ?? "Open",
    hasDispute: d[166] === 1,
    disputeEndTs: Number(d.readBigInt64LE(121)),
    startTs: Number(d.readBigInt64LE(105)),
  };
}

export function rpc(): Connection {
  return connection();
}
