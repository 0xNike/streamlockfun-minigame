/**
 * Handles the server's `sign_request` frames on the active match socket:
 *   - reserve: lock this player's stake for the match (their on-chain consent).
 *   - dispute: open an on-chain dispute the player asked for.
 * The tx arrives already signed by the operator; the player adds their
 * signature in their wallet and we hand it back. The server checks it's the
 * exact tx it built before submitting it.
 */

import { useEffect, useState } from "react";
import { useSignTransaction } from "@privy-io/react-auth/solana";
import { onAnyFrame, sendActive } from "../ws";
import { useWalletAddress } from "../useWalletAddress";
import type { SignPurpose } from "../types";

type Req = { purpose: SignPurpose; tx: string; bps?: number; deadline: number };

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function StakeSignPrompt() {
  const { wallet } = useWalletAddress();
  const { signTransaction } = useSignTransaction();
  const [req, setReq] = useState<Req | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(
    () =>
      onAnyFrame((f) => {
        if (f.type === "sign_request") {
          setReq({ purpose: f.purpose, tx: f.tx, bps: f.bps, deadline: f.deadline });
          setErr(null);
        } else if (f.type === "state" && f.state !== "reserving" && f.state !== "dispute_wait") {
          setReq(null);
        } else if (f.type === "error" && f.code === "SIGN_REJECTED") {
          setErr(f.message);
          setBusy(false);
        }
      }),
    [],
  );

  useEffect(() => {
    if (!req) return;
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [req]);

  if (!req || !wallet) return null;

  async function sign() {
    if (!req || !wallet) return;
    setBusy(true);
    setErr(null);
    try {
      const { signedTransaction } = await signTransaction({ transaction: b64ToBytes(req.tx), wallet });
      sendActive({ type: "signed_tx", purpose: req.purpose, tx: bytesToB64(signedTransaction) });
      setReq(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const left = Math.max(0, req.deadline - now);
  const pct = req.bps != null ? (req.bps / 100).toFixed(2) : null;

  return (
    <div className="hold" role="dialog" aria-live="polite">
      {req.purpose === "reserve" ? (
        <>
          <div className="hold__label">Lock your stake to start</div>
          <div className="hold__sub">
            Approve in your wallet to lock {pct ? `${pct}% of your stream` : "your stake"} for this
            match. This is your on-chain consent: no one can move your share without it. It costs
            you nothing{left > 0 ? `, and the match is cancelled if it isn't signed in ${left}s` : ""}.
          </div>
        </>
      ) : (
        <>
          <div className="hold__label">Confirm your dispute</div>
          <div className="hold__sub">
            Approve in your wallet to open an on-chain dispute. You pay a small record fee, refunded
            when the match is closed.
          </div>
        </>
      )}
      <button className="btn" onClick={sign} disabled={busy || left === 0}>
        {busy ? "Waiting for wallet…" : req.purpose === "reserve" ? "Approve stake lock" : "Sign dispute"}
      </button>
      {err && <div className="dim small">Couldn't sign: {err}</div>}
    </div>
  );
}
