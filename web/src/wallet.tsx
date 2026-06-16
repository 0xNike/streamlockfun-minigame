/**
 * Wallet provider. Wraps the app in Privy so players can connect an external
 * Solana wallet (Phantom, Backpack, …) OR log in with email/Google and get a
 * Privy-managed embedded Solana wallet auto-provisioned for them.
 *
 * The minigame never builds or sends transactions from the browser — the
 * operator server settles every match on-chain with its own keypair, and the
 * frontend only ever needs the connected wallet's address (see
 * `useWalletAddress`). That keeps this integration identity-only: no signing
 * surface to wire up here.
 *
 * Both Solana clusters are registered statically below. Those RPCs only back
 * Privy's balance display / standard-sign hooks, neither of which this app
 * uses, so we don't need to read /api/config to pick one — registering both
 * avoids re-mounting the provider (and dropping auth state) on a cluster swap.
 */

import { type ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";

const APP_ID = import.meta.env.VITE_PRIVY_APP_ID as string | undefined;

const solanaRpcs = {
  "solana:mainnet": {
    rpc: createSolanaRpc("https://api.mainnet-beta.solana.com"),
    rpcSubscriptions: createSolanaRpcSubscriptions("wss://api.mainnet-beta.solana.com"),
  },
  "solana:devnet": {
    rpc: createSolanaRpc("https://api.devnet.solana.com"),
    rpcSubscriptions: createSolanaRpcSubscriptions("wss://api.devnet.solana.com"),
  },
};

export function WalletShell({ children }: { children: ReactNode }) {
  if (!APP_ID) {
    // Fail loud rather than render a half-initialized auth state that silently
    // never connects. Set VITE_PRIVY_APP_ID in web/.env.local (see .env.example).
    return (
      <div className="card error" style={{ margin: "2rem auto", maxWidth: 480 }}>
        Missing <code>VITE_PRIVY_APP_ID</code>. Create a Privy app at
        dashboard.privy.io and add its App ID to <code>web/.env.local</code>.
      </div>
    );
  }
  return (
    <PrivyProvider
      appId={APP_ID}
      config={{
        // Solana-only app; lead the modal with wallet connectors (external is
        // the primary path) and offer email/Google below for embedded wallets.
        // walletList is an explicit allow-list: only these wallet buttons show.
        // Omitting "detected_solana_wallets" hides every other detected
        // extension, so add a wallet here to surface it.
        appearance: {
          walletChainType: "solana-only",
          showWalletLoginFirst: true,
          walletList: ["phantom", "solflare"],
        },
        loginMethods: ["wallet", "email", "google"],
        externalWallets: { solana: { connectors: toSolanaWalletConnectors() } },
        // Email/social users (no external wallet) get an embedded Solana wallet;
        // users who connect Phantom keep theirs and get no duplicate.
        embeddedWallets: { solana: { createOnLogin: "users-without-wallets" } },
        solana: { rpcs: solanaRpcs },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
