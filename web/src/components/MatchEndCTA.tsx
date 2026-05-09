import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import { api } from "../api";
import type { MatchSnapshot, Side } from "../types";

export function MatchEndCTA({
  snap,
  you,
  matchId,
  shareUrl,
}: {
  snap: MatchSnapshot;
  you: Side | null;
  matchId: string;
  shareUrl: string;
}) {
  const navigate = useNavigate();
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<"link" | "id" | null>(null);

  const yourStream = you === "a" ? snap.playerA.streamId : snap.playerB?.streamId ?? null;

  async function playAgain() {
    if (!wallet || !yourStream) {
      setErr("Connect a wallet with a stream to start a new match.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const { matchId: newId } = await api.createMatch({ wallet, streamId: yourStream });
      navigate(`/match/${newId}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string, kind: "link" | "id") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied((c) => (c === kind ? null : c)), 1500);
    } catch {
      // ignore
    }
  }

  const goHome = () => navigate("/");

  // Decide which buttons to show
  const isDone = snap.state === "done";
  const isCancelled = snap.state === "cancelled";
  const isFailed = snap.state === "failed";
  if (!isDone && !isCancelled && !isFailed) return null;

  const youWon = isDone && snap.winner === you && you !== null;

  return (
    <div className="cta">
      <div className="cta__row">
        {(isDone || isCancelled) && (
          <button className="primary" onClick={playAgain} disabled={busy || !yourStream}>
            {busy ? "Creating match…" : isCancelled ? "Try again" : "Play again"}
          </button>
        )}

        {youWon && (
          <button onClick={() => copy(shareUrl, "link")}>
            {copied === "link" ? "Link copied!" : "Share win"}
          </button>
        )}

        {isFailed && (
          <button className="primary" onClick={goHome}>
            Back to home
          </button>
        )}

        {!isFailed && (
          <button className="link" onClick={goHome}>
            Back to home
          </button>
        )}

        {isFailed && (
          <button onClick={() => copy(matchId, "id")}>
            {copied === "id" ? "ID copied!" : "Copy match id"}
          </button>
        )}
      </div>

      {!yourStream && (isDone || isCancelled) && (
        <div className="dim small cta__hint">
          Reconnect your wallet to start a new match.
        </div>
      )}

      {err && <div className="error cta__hint">{err}</div>}
    </div>
  );
}
