/**
 * Prove wallet control to the games server: sign a one-time message with the
 * active Privy wallet (external or embedded), exchange it for a token.
 * `ensureSignedIn()` is a no-op when a valid token for this wallet exists.
 */

import { useCallback } from "react";
import { useSignMessage } from "@privy-io/react-auth/solana";
import { api } from "./api";
import { setToken, tokenFor } from "./authStore";
import { useWalletAddress } from "./useWalletAddress";

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function useWalletAuth() {
  const { address, wallet } = useWalletAddress();
  const { signMessage } = useSignMessage();

  const ensureSignedIn = useCallback(async (): Promise<void> => {
    if (!address || !wallet) throw new Error("Connect a wallet first");
    if (tokenFor(address)) return;
    const { message } = await api.auth.nonce(address);
    const { signature } = await signMessage({
      message: new TextEncoder().encode(message),
      wallet,
      options: { uiOptions: { title: "Sign in to Streamlock Games" } },
    });
    const out = await api.auth.verify(address, message, toB64(signature));
    setToken({ wallet: out.wallet, token: out.token, exp: out.exp });
  }, [address, wallet, signMessage]);

  return { ensureSignedIn, signedIn: !!tokenFor(address) };
}
