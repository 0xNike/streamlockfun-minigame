import { useEffect, useRef, useState } from "react";
import type { MatchSnapshot, MatchState, TxKind } from "../types";

interface TxEvent {
  kind: TxKind;
  attempt: number;
  status: "pending" | "confirmed" | "failed";
  sig?: string;
  error?: string;
  ts: number;
}

function explorer(sig: string) {
  return `https://solscan.io/tx/${sig}?cluster=devnet`;
}

function fmtClock(sec: number): string {
  if (sec <= 0) return "0s";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m > 0 ? `${m}m ${s.toString().padStart(2, "0")}s` : `${s}s`;
}

const STEPS = [
  { key: "decided", label: "Match decided" },
  { key: "lock", label: "Locking in result" },
  { key: "hold", label: "Anti-cheat hold" },
  { key: "payout", label: "Sending payout" },
] as const;

function activeStepIndex(state: MatchState): number {
  switch (state) {
    case "complete":
      return 0;
    case "submitting":
      return 1;
    case "dispute_wait":
      return 2;
    case "finalizing":
    case "applying":
      return 3;
    case "done":
      return 4;
    default:
      return -1;
  }
}

export function SettlementProgress({
  snap,
  txEvents,
}: {
  snap: MatchSnapshot;
  txEvents: TxEvent[];
}) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  // Track when each step started so we can show "running for Xs".
  const stepEnteredRef = useRef<Map<number, number>>(new Map());
  const idx = activeStepIndex(snap.state);
  if (idx >= 0 && !stepEnteredRef.current.has(idx)) {
    stepEnteredRef.current.set(idx, Math.floor(Date.now() / 1000));
  }
  const stepStartedAt = idx >= 0 ? stepEnteredRef.current.get(idx) ?? now : now;
  const stepElapsed = Math.max(0, now - stepStartedAt);

  // Cancellation flow.
  if (snap.state === "cancelling" || snap.state === "cancelled") {
    return (
      <div className="settle settle--cancel">
        <div className="settle__title">
          {snap.state === "cancelling" ? "Cancelling…" : "Cancelled"}
        </div>
        <div className="dim small">
          No funds will move. Any setup costs are refunded automatically.
        </div>
        <SigDisclosure txEvents={txEvents} />
      </div>
    );
  }

  if (snap.state === "failed") {
    return (
      <div className="settle settle--fail">
        <div className="settle__title">Something went wrong</div>
        <div className="dim small">
          {snap.failedReason ??
            "Settlement failed. Reach out to support and we'll sort it out."}
        </div>
        <SigDisclosure txEvents={txEvents} />
      </div>
    );
  }

  if (idx < 0) return null;

  // Anti-cheat hold: render a big numeric countdown above the steps.
  const inHold = snap.state === "dispute_wait";
  const windowSec = Math.max(1, snap.disputeWindowSec);
  const eligibleAt =
    snap.finalizeEligibleAt ?? stepStartedAt + windowSec; // fallback if endTs missing
  const remaining = Math.max(0, eligibleAt - now);
  const elapsedInWindow = Math.max(0, Math.min(windowSec, windowSec - remaining));
  const windowFillPct = (elapsedInWindow / windowSec) * 100;

  const progressPct = Math.min(100, Math.max(0, (idx / STEPS.length) * 100));

  return (
    <div className="settle">
      <div className="settle__head">
        <div className="settle__title">
          {idx >= STEPS.length ? "All done" : STEPS[idx].label}
        </div>
        <div className="settle__step-num">
          {Math.min(idx + 1, STEPS.length)} of {STEPS.length}
        </div>
      </div>

      <div className="settle__bar">
        <div className="settle__bar-fill" style={{ width: `${progressPct}%` }} />
      </div>

      {inHold ? (
        <div className="hold">
          <div className="hold__label">Anti-cheat hold</div>
          <div className="hold__time">{fmtClock(remaining)}</div>
          <div className="hold__sub">
            Brief safety window so anyone could challenge the result. Payout
            starts automatically when this reaches 0.
          </div>
          <div className="hold__bar">
            <div className="hold__bar-fill" style={{ width: `${windowFillPct}%` }} />
          </div>
        </div>
      ) : (
        <div className="settle__elapsed dim small">
          Working on this step for {fmtClock(stepElapsed)}…
        </div>
      )}

      <div className="settle__steps">
        {STEPS.map((step, i) => {
          const cls = i < idx ? "done" : i === idx ? "active" : "todo";
          return (
            <div key={step.key} className={`settle__step ${cls}`}>
              <div className="settle__step-dot">
                {cls === "active" && <span className="settle__step-spinner" />}
              </div>
              <div className="settle__step-label">{step.label}</div>
            </div>
          );
        })}
      </div>

      <SigDisclosure txEvents={txEvents} />
    </div>
  );
}

function SigDisclosure({ txEvents }: { txEvents: TxEvent[] }) {
  const sigs: string[] = [];
  for (const ev of txEvents) {
    if (ev.status === "confirmed" && ev.sig && !sigs.includes(ev.sig)) sigs.push(ev.sig);
  }
  if (sigs.length === 0) return null;
  return (
    <details className="settle__sigs">
      <summary>View on-chain transactions ({sigs.length})</summary>
      <div className="settle__sigs-list">
        {sigs.map((sig) => (
          <a key={sig} href={explorer(sig)} target="_blank" rel="noreferrer">
            {sig.slice(0, 8)}…{sig.slice(-6)} ↗
          </a>
        ))}
      </div>
    </details>
  );
}
