/**
 * Browser commit-reveal helpers.
 *
 * `commitHash(move, nonce)` mirrors the server-side `commitHash` in
 * src/server/rps.ts: lowercase-hex sha256(`${move}:${nonce}`).
 * The 16-byte nonce makes preimage attacks against the 3-move space infeasible.
 */

import type { Move } from "./types";

const HEX = "0123456789abcdef";

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += HEX[(b >> 4) & 0xf] + HEX[b & 0xf];
  }
  return out;
}

/** 16 random bytes → 32 lowercase hex chars. */
export function newNonce(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

/** sha256(`${move}:${nonce}`) as lowercase hex. */
export async function commitHash(move: Move, nonce: string): Promise<string> {
  const data = new TextEncoder().encode(`${move}:${nonce}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}
