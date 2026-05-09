/**
 * Fetches the connected wallet's eligible streams on a given token mint
 * and renders a chooser:
 *   - 0 streams → friendly error with no controls
 *   - 1 stream  → static display, parent gets the streamId via onChange
 *   - 2+        → <select> dropdown
 *
 * Used by Home (creator picks before creating) and Match pre-join (joiner picks
 * before confirming).
 */

import { useEffect, useState } from "react";
import { api } from "../api";
import { formatToken } from "../format";
import type { TokenMetaPublic } from "../types";

function shortStream(s: string) {
  return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}

interface StreamRow {
  streamId: string;
  effectiveBps?: number | null;
  lockedTokenAmount?: string | null;
}

export function StreamPicker({
  wallet,
  tokenMint,
  tokenMeta,
  value,
  onChange,
}: {
  wallet: string | null;
  tokenMint: string | null;
  tokenMeta?: TokenMetaPublic | null;
  value: string | null;
  onChange: (streamId: string | null) => void;
}) {
  const [streams, setStreams] = useState<StreamRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!wallet || !tokenMint) {
      setStreams(null);
      onChange(null);
      return;
    }
    setBusy(true);
    setErr(null);
    setStreams(null);
    void api
      .getMyStreams(wallet, tokenMint)
      .then((res) => {
        setStreams(res.streams);
        if (res.streams.length === 1) onChange(res.streams[0].streamId);
        else if (value && !res.streams.some((s) => s.streamId === value)) {
          onChange(null);
        }
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, tokenMint]);

  if (!wallet) return <div className="dim small">Connect wallet to see streams.</div>;
  if (!tokenMint) return <div className="dim small">Enter a token mint to see streams.</div>;
  if (busy) return <div className="dim small">Loading streams…</div>;
  if (err) return <div className="error small">{err}</div>;
  if (!streams) return null;

  if (streams.length === 0) {
    return (
      <div className="picker__empty">
        <div className="error">No eligible streams on this token mint.</div>
        <div className="dim small">
          Acquire a stream by lock-buying this token, then refresh.
        </div>
      </div>
    );
  }

  // Per-row label: prefer concrete "X TOKEN (Y%)" over bare bps.
  function rowLabel(s: StreamRow): string {
    const bps = s.effectiveBps;
    if (bps === null || bps === undefined) return "";
    const pct = `${(bps / 100).toFixed(2)}%`;

    const yoursBaseUnits = s.lockedTokenAmount
      ? safeDiv(BigInt(s.lockedTokenAmount), BigInt(bps), 10000n)
      : null;
    const tokens = formatToken(yoursBaseUnits, tokenMeta?.decimals ?? null, tokenMeta?.symbol ?? null);
    return tokens ? ` — ${tokens} (${pct} yours)` : ` — ${pct} yours`;
  }

  if (streams.length === 1) {
    return (
      <div className="picker__single">
        <span className="dim small">Stream:</span>
        <code>{shortStream(streams[0].streamId)}</code>
        <span className="dim small">{rowLabel(streams[0])} (only one — auto-selected)</span>
      </div>
    );
  }

  return (
    <select
      className="picker"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">Select a stream…</option>
      {streams.map((s) => (
        <option key={s.streamId} value={s.streamId}>
          {shortStream(s.streamId)}
          {rowLabel(s)}
        </option>
      ))}
    </select>
  );
}

function safeDiv(amount: bigint, num: bigint, denom: bigint): bigint | null {
  try {
    return (amount * num) / denom;
  } catch {
    return null;
  }
}
