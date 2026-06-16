import { useState } from "react";
import type { MatchSnapshot, Side } from "../../../shared/types";

const STATE_LABEL: Record<string, string> = {
  partnered: "waiting for opponent",
  creating: "creating session…",
  active: "match in progress",
  complete: "match decided",
  submitting: "submitting deltas…",
  dispute_wait: "dispute window…",
  finalizing: "finalizing…",
  applying: "applying deltas…",
  done: "✅ done",
  cancelling: "cancelling…",
  cancelled: "cancelled",
  failed: "failed",
};

// Visual phase grouping → state-pill modifier class. Players don't care about
// the difference between "submitting" and "applying" — they care that the
// match is running, settling, done, or in trouble.
function phaseModifier(state: string): string {
  switch (state) {
    case "active":
    case "complete":
      return "state-pill--active";
    case "submitting":
    case "dispute_wait":
    case "finalizing":
    case "applying":
    case "cancelling":
      return "state-pill--settling";
    case "done":
      return "state-pill--done";
    case "cancelled":
    case "failed":
      return "state-pill--bad";
    default:
      return "";
  }
}

function shortAddr(s: string) {
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

export function MatchHeader({
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
  const a = snap.playerA;
  const b = snap.playerB;
  const [copied, setCopied] = useState<"link" | "id" | null>(null);

  async function copy(text: string, kind: "link" | "id") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied((c) => (c === kind ? null : c)), 1500);
    } catch {
      // ignore
    }
  }

  return (
    <header className="match-header">
      <div className="match-header__top">
        <div className={`state-pill ${phaseModifier(snap.state)}`}>
          {STATE_LABEL[snap.state] ?? snap.state}
        </div>
        <div className="match-header__actions">
          <button className="link" onClick={() => copy(matchId, "id")}>
            {copied === "id" ? "id copied!" : "copy match id"}
          </button>
          <button className="link" onClick={() => copy(shareUrl, "link")}>
            {copied === "link" ? "link copied!" : "copy match link"}
          </button>
        </div>
      </div>
      <div className="players">
        <div className={`player ${you === "a" ? "is-you" : ""} ${a.connected ? "" : "off"}`}>
          <div className="player__label">A {you === "a" && <span className="you">(you)</span>}</div>
          <div className="player__addr">{shortAddr(a.wallet)}</div>
          <div className="player__stream">stream {shortAddr(a.streamId)}</div>
        </div>
        <div className="vs">vs</div>
        {b ? (
          <div className={`player ${you === "b" ? "is-you" : ""} ${b.connected ? "" : "off"}`}>
            <div className="player__label">B {you === "b" && <span className="you">(you)</span>}</div>
            <div className="player__addr">{shortAddr(b.wallet)}</div>
            <div className="player__stream">stream {shortAddr(b.streamId)}</div>
          </div>
        ) : (
          <div className="player off">
            <div className="player__label">B</div>
            <div className="dim small">waiting…</div>
          </div>
        )}
      </div>
    </header>
  );
}
