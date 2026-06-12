/**
 * Wallet adapter provider. Reads the target cluster from /api/config so the
 * wallet's balance display and tx simulation hit the same chain the operator
 * is running against. Defaults to mainnet during the brief loading window;
 * the operator's settlement path is the source of truth either way.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";
import { clusterApiUrl } from "@solana/web3.js";
import { api } from "./api";
import "@solana/wallet-adapter-react-ui/styles.css";

type Cluster = "mainnet-beta" | "devnet";

export function WalletShell({ children }: { children: ReactNode }) {
  // Loading default: mainnet. If /api/config says soldev/devnet we switch
  // once it resolves (~tens of ms). React's connection provider re-mounts
  // the underlying connection on endpoint change, so this is safe.
  const [cluster, setCluster] = useState<Cluster>("mainnet-beta");
  useEffect(() => {
    void api
      .getConfig()
      .then((cfg) => {
        setCluster(cfg.explorerCluster === "mainnet" ? "mainnet-beta" : "devnet");
      })
      .catch(() => {
        // Network failure → leave the default. User can still connect and
        // sign; balance display may be off until /api/config recovers.
      });
  }, []);

  const endpoint = useMemo(() => clusterApiUrl(cluster), [cluster]);
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
