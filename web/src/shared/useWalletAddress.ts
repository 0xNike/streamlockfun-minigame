/**
 * Single source of truth for "which wallet address is the player using".
 *
 * Replaces the old `useWallet().publicKey?.toBase58()` from the Solana wallet
 * adapter. Privy can attach more than one Solana wallet to a user (e.g. an
 * email login that auto-creates an embedded wallet AND a later-connected
 * Phantom), so we resolve a single active address: prefer an external,
 * user-owned wallet and fall back to the embedded Privy wallet.
 */

import { usePrivy } from "@privy-io/react-auth";
import { useWallets } from "@privy-io/react-auth/solana";

export interface WalletAddress {
  /** Base58 Solana address of the active wallet, or null when not connected. */
  address: string | null;
  /** True once Privy is ready, the user is authenticated, and we have an address. */
  connected: boolean;
  /** Privy SDK has finished initializing. Gate UI on this to avoid flicker. */
  ready: boolean;
  /** Open the Privy login/connect modal. */
  login: () => void;
  /** Log out and disconnect all wallets. */
  logout: () => Promise<void>;
}

export function useWalletAddress(): WalletAddress {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();

  const external = wallets.find((w) => w.standardWallet.name !== "Privy");
  const active = external ?? wallets[0] ?? null;
  const address = active?.address ?? null;

  return {
    address,
    connected: authenticated && address !== null,
    ready,
    login: () => login(),
    logout,
  };
}
