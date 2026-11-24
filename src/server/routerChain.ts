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
 * Layouts mirror the live IDL (anchor idl fetch 2atKseCg…, 2026-11-24). Every
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
