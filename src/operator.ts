import { StreamlockOperator, type Chain } from "@streamlock/operator-sdk";
import { Keypair } from "@solana/web3.js";
import { config } from "dotenv";
config({ path: ".env.local" });

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.startsWith("REPLACE_ME") || v === "sk_REPLACE_ME") {
    throw new Error(`Env var ${name} is missing or still set to a placeholder. Copy .env.example to .env and fill it in.`);
  }
  return v;
}

const OPERATOR_KEYPAIR = Keypair.fromSecretKey(
  Buffer.from(required("OPERATOR_SECRET_KEY_B64"), "base64"),
);

export const op = new StreamlockOperator({
  apiKey: required("STREAMLOCK_OPERATOR_KEY"),
  chain: (process.env.STREAMLOCK_CHAIN ?? "soldev") as Chain,
  baseUrl: process.env.STREAMLOCK_BASE_URL,
  rpcUrl: required("SOLANA_RPC_URL"),
  signer: async (tx) => {
    tx.sign([OPERATOR_KEYPAIR]);
    return tx;
  },
});

export const GAME_TOKEN_MINT = required("GAME_TOKEN_MINT");
export const OPERATOR_PUBKEY = OPERATOR_KEYPAIR.publicKey.toBase58();

/** Operator co-signature for txs the games server builds directly
 *  (reserve_stake / release_stake). Never exposes the secret key. */
export function operatorSign<T extends { partialSign(...signers: Keypair[]): void }>(tx: T): T {
  tx.partialSign(OPERATOR_KEYPAIR);
  return tx;
}
export const OPERATOR_PUBLIC_KEY = OPERATOR_KEYPAIR.publicKey;
