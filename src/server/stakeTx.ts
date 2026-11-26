/**
 * Router txs the games server builds itself: reserve_stake, release_stake,
 * open_dispute. The session lifecycle (create/submit/finalize/apply/cancel)
 * still goes through the Operator API + SDK. These three are new with the
 * Option B router (devnet 8jX8…, 2026-11-25) and need a player's signature,
 * which the API flow has no slot for.
 *
 * Signing model:
 *   reserve_stake: holder (consent) + payer + operator. The operator partially
 *     signs here; the player co-signs in the browser; we verify the message is
 *     byte-identical to what we built, then submit.
 *   release_stake: operator only.
 *   open_dispute:  the disputing player only (they also pay the record rent).
 */

import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { OPERATOR_PUBLIC_KEY, operatorSign } from "../operator.js";
import { config } from "./config.js";
import {
  ROUTER_PROGRAM_ID,
  disputeRecordPda,
  entitlementChunk0Pda,
  holderSalePda,
  ledgerPda,
  routerParamsPda,
  routerRolePda,
  rpc,
  shareStatePda,
} from "./routerChain.js";

// Anchor discriminators from the on-chain IDL.
const DISC = {
  reserve_stake: Buffer.from([61, 60, 244, 149, 239, 154, 75, 61]),
  release_stake: Buffer.from([51, 5, 28, 250, 185, 168, 18, 53]),
  open_dispute: Buffer.from([137, 25, 99, 119, 23, 223, 161, 42]),
};

const ro = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });
const rw = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

const sid = (hex: string) => Buffer.from(hex, "hex");

function computeIxs(units: number): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
  ];
}

async function freshTx(feePayer: PublicKey, ixs: TransactionInstruction[]): Promise<Transaction> {
  // `confirmed`, not `finalized`: the player needs as much of the ~60–90 s
  // validity window as possible to review and sign.
  const { blockhash, lastValidBlockHeight } = await rpc().getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer, blockhash, lastValidBlockHeight });
  tx.add(...ixs);
  return tx;
}

/**
 * reserve_stake(stream_id, bps). Returns the tx partially signed by the
 * operator; the holder must co-sign. `payer` funds the HolderSale PDA if it
 * doesn't exist yet (~0.0018 SOL, refunded to the payer after the position
 * settles). RESERVE_RENT_PAYER picks operator (default) or the player.
 */
export async function buildReserveStakeTx(args: {
  sessionPda: string;
  holder: string;
  streamId: string;
  bps: number;
  /** Who funds the HolderSale if it's new (see rentCaps.ts). Defaults to RESERVE_RENT_PAYER. */
  rentPayer?: "operator" | "player";
}): Promise<Transaction> {
  const holder = new PublicKey(args.holder);
  const payer = (args.rentPayer ?? config.RESERVE_RENT_PAYER) === "player" ? holder : OPERATOR_PUBLIC_KEY;
  const keys = [
    ro(holder, true),
    rw(payer, true),
    ro(OPERATOR_PUBLIC_KEY, true),
    ro(routerRolePda(OPERATOR_PUBLIC_KEY)),
    ro(new PublicKey(args.sessionPda)),
    ro(ledgerPda(args.streamId)),
    ro(entitlementChunk0Pda(args.streamId)),
    rw(holderSalePda(args.streamId, args.holder)),
    ro(shareStatePda(args.streamId)),
    ro(routerParamsPda()),
    ro(SystemProgram.programId),
  ];
  // payer and holder may be the same key; web3.js merges duplicate metas
  // (signer|writable OR'd), which is what the program expects.
  const ix = new TransactionInstruction({
    programId: ROUTER_PROGRAM_ID,
    keys,
    data: Buffer.concat([DISC.reserve_stake, sid(args.streamId), u16(args.bps)]),
  });
  // The operator pays the fee so a player with 0 SOL can still consent.
  const tx = await freshTx(OPERATOR_PUBLIC_KEY, [...computeIxs(80_000), ix]);
  return operatorSign(tx);
}

/** release_stake(stream_id), operator path. game_session = the reserving session. */
export async function buildReleaseStakeTx(args: {
  sessionPda: string;
  holder: string;
  streamId: string;
}): Promise<Transaction> {
  const ix = new TransactionInstruction({
    programId: ROUTER_PROGRAM_ID,
    keys: [
      ro(OPERATOR_PUBLIC_KEY, true),
      rw(holderSalePda(args.streamId, args.holder)),
      ro(new PublicKey(args.sessionPda)),
      ro(routerRolePda(OPERATOR_PUBLIC_KEY)), // optional account, present → operator path
    ],
    data: Buffer.concat([DISC.release_stake, sid(args.streamId)]),
  });
  const tx = await freshTx(OPERATOR_PUBLIC_KEY, [...computeIxs(40_000), ix]);
  return operatorSign(tx);
}

/**
 * open_dispute(reason_code). The disputer signs and pays (record rent + fee).
 * `holder_sale` is the disputer's HolderSale for the stream they staked in this
 * session; the program requires its reservation to be bound to the session.
 */
export async function buildOpenDisputeTx(args: {
  sessionPda: string;
  disputer: string;
  streamId: string;
  reasonCode: number;
}): Promise<Transaction> {
  const session = new PublicKey(args.sessionPda);
  const disputer = new PublicKey(args.disputer);
  const ix = new TransactionInstruction({
    programId: ROUTER_PROGRAM_ID,
    keys: [
      rw(session),
      rw(disputeRecordPda(session, disputer)),
      ro(disputer, true),
      ro(holderSalePda(args.streamId, args.disputer)),
      rw(disputer, true), // payer
      ro(SystemProgram.programId),
    ],
    data: Buffer.concat([DISC.open_dispute, Buffer.from([args.reasonCode & 0xff])]),
  });
  return freshTx(disputer, [...computeIxs(60_000), ix]);
}

/** base64 of the tx with whatever signatures it has so far. */
export function txToB64(tx: Transaction): string {
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

/**
 * Accept a player-signed copy of `expected` only if its message bytes are
 * identical (so the player can't swap accounts/args) and every required
 * signature verifies. Returns the fully signed tx ready to send.
 */
export function acceptPlayerSigned(expected: Transaction, signedB64: string, player: string): Transaction {
  const signed = Transaction.from(Buffer.from(signedB64, "base64"));
  const a = expected.serializeMessage();
  const b = signed.serializeMessage();
  if (!a.equals(b)) throw new Error("signed transaction does not match the one requested");
  const sig = signed.signatures.find((s) => s.publicKey.toBase58() === player)?.signature;
  if (!sig) throw new Error("transaction is missing the player's signature");
  expected.addSignature(new PublicKey(player), Buffer.from(sig));
  if (!expected.verifySignatures(true)) throw new Error("transaction signatures do not verify");
  return expected;
}

/** Send a fully signed tx and wait for `confirmed`. Throws on any on-chain error. */
export async function sendAndConfirm(tx: Transaction): Promise<string> {
  const conn = rpc();
  const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
  const res = await conn.confirmTransaction(
    { signature: sig, blockhash: tx.recentBlockhash!, lastValidBlockHeight: tx.lastValidBlockHeight! },
    "confirmed",
  );
  if (res.value.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(res.value.err)}`);
  return sig;
}

/** Release one reservation (operator path). Tolerates "nothing to release". */
export async function releaseStake(args: {
  sessionPda: string;
  holder: string;
  streamId: string;
}): Promise<string | null> {
  const tx = await buildReleaseStakeTx(args);
  try {
    return await sendAndConfirm(tx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // No HolderSale / not reserved for this session: nothing to do.
    if (msg.includes("AccountNotInitialized") || msg.includes("0xbc4") || msg.includes("NotReserved")) return null;
    throw err;
  }
}
