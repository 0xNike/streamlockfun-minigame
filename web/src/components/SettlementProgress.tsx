import { useEffect, useRef, useState } from "react";
import type { MatchSnapshot, MatchState, Side, TxKind } from "../types";
import { formatToken, stakeBaseUnits } from "../format";

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

function pct(bps: number) {
  return `${(bps / 100).toFixed(2)}%`;
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
  you,
  txEvents,
}: {
  snap: MatchSnapshot;
  you: Side | null;
  txEvents: TxEvent[];
}) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const stepEnteredRef = useRef<Map<number, number>>(new Map());
  const idx = activeStepIndex(snap.state);
  if (idx >= 0 && !stepEnteredRef.current.has(idx)) {
    stepEnteredRef.current.set(idx, Math.floor(Date.now() / 1000));
  }
  const stepStartedAt = idx >= 0 ? stepEnteredRef.current.get(idx) ?? now : now;
  const stepElapsed = Math.max(0, now - stepStartedAt);

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

  const inHold = snap.state === "dispute_wait";
  const windowSec = Math.max(1, snap.disputeWindowSec);
  const eligibleAt = snap.finalizeEligibleAt ?? stepStartedAt + windowSec;
  const remaining = Math.max(0, eligibleAt - now);
  const elapsedInWindow = Math.max(0, Math.min(windowSec, windowSec - remaining));
  const windowFillPct = (elapsedInWindow / windowSec) * 100;
  const progressPct = Math.min(100, Math.max(0, (idx / STEPS.length) * 100));

  // Latest confirmed `submit` signature — the on-chain artifact the curious
  // would want to inspect during the hold. Showing it prominently (rather
  // than buried in a disclosure) so players have something concrete to do.
  const submitSig = latestConfirmedSig(txEvents, "submit");

  // Pending-payout deltas, shown during hold + finalize + applying so players
  // can see exactly what's about to land. Only meaningful when there's a winner.
  const showPending =
    snap.winner === "a" || snap.winner === "b";

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
            Brief safety window so the result can be verified before payout
            settles. Payout starts automatically when this hits 0.
          </div>
          <div className="hold__bar">
            <div className="hold__bar-fill" style={{ width: `${windowFillPct}%` }} />
          </div>
          <div className="hold__safe">
            ✓ You can close this tab — your payout will land automatically.
          </div>
        </div>
      ) : (
        <div className="settle__elapsed dim small">
          Working on this step for {fmtClock(stepElapsed)}…
          {idx >= 1 && idx < STEPS.length && (
            <span> · You can close this tab; we'll finish without you.</span>
          )}
        </div>
      )}

      {showPending && <PendingPayout snap={snap} you={you} />}

      {submitSig && (
        <a
          className="settle__chain-link"
          href={explorer(submitSig)}
          target="_blank"
          rel="noreferrer"
        >
          View submitted result on Solscan ↗
        </a>
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

function PendingPayout({
  snap,
  you,
}: {
  snap: MatchSnapshot;
  you: Side | null;
}) {
  if (snap.winner !== "a" && snap.winner !== "b") return null;
  if (!snap.playerB) return null;

  const loserSlot = snap.winner === "a" ? snap.playerB : snap.playerA;

  // Prefer the wager snapshot's per-outcome bps + amount when present (the
  // amount-based path); fall back to loser-derived math for legacy matches.
  const settledBps = snap.wager
    ? snap.winner === "a"
      ? snap.wager.bpsIfALoses
      : snap.wager.bpsIfBLoses
    : snap.bpsAtStake;
  const wagerBaseUnits = snap.wager
    ? safeBigInt(snap.wager.amountRaw)
    : stakeBaseUnits(loserSlot.lockedTokenAmount, snap.bpsAtStake);
  const wagerTokens = formatToken(
    wagerBaseUnits,
    snap.tokenMeta?.decimals ?? null,
    snap.tokenMeta?.symbol ?? null,
  );
  const stakePct = pct(settledBps);
  const youAreWinner = you !== null && you === snap.winner;
  const youAreLoser = you !== null && you !== snap.winner;

  const winnerLabel = youAreWinner ? "You" : "Winner";
  const loserLabel = youAreLoser ? "You" : "Opponent";
  const winnerCopy = youAreWinner ? "earn" : "earns";
  const loserCopy = youAreLoser ? "give up" : "gives up";

  return (
    <div className="pending">
      <div className="pending__title">Pending payout</div>
      <div className="pending__row pending__row--win">
        <span className="pending__sign">+</span>
        <span className="pending__amt">
          <strong>{wagerTokens ?? `${stakePct} of stream`}</strong>
          {wagerTokens && <span className="dim small"> ({stakePct})</span>}
        </span>
        <span className="pending__who">{winnerLabel} {winnerCopy}</span>
      </div>
      <div className="pending__row pending__row--loss">
        <span className="pending__sign">−</span>
        <span className="pending__amt">
          <strong>{wagerTokens ?? `${stakePct} of stream`}</strong>
          {wagerTokens && <span className="dim small"> ({stakePct})</span>}
        </span>
        <span className="pending__who">{loserLabel} {loserCopy}</span>
      </div>
    </div>
  );
}

function safeBigInt(s: string): bigint | null {
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

function latestConfirmedSig(txEvents: TxEvent[], kind: TxKind): string | null {
  let best: TxEvent | null = null;
  for (const ev of txEvents) {
    if (ev.kind !== kind) continue;
    if (ev.status !== "confirmed" || !ev.sig) continue;
    if (!best || ev.ts >= best.ts) best = ev;
  }
  return best?.sig ?? null;
}

function SigDisclosure({ txEvents }: { txEvents: TxEvent[] }) {
  const sigs: string[] = [];
  for (const ev of txEvents) {
    if (ev.status === "confirmed" && ev.sig && !sigs.includes(ev.sig)) sigs.push(ev.sig);
  }
  if (sigs.length === 0) return null;
  return (
    <details className="settle__sigs">
      <summary>All on-chain transactions ({sigs.length})</summary>
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
