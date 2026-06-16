import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useWalletAddress } from "../../shared/useWalletAddress";
import { api, type ServerConfig } from "../../shared/api";
import { openWs, type WsClient } from "../../shared/ws";
import { commitHash, newNonce } from "../../shared/crypto";
import type {
  MatchSnapshot,
  Move,
  PlayerSlotSnapshot,
  RoundResult,
  ServerFrame,
  Side,
  TxKind,
} from "../../shared/types";
import { MoveButtons } from "./components/MoveButtons";
import { RoundList } from "./components/RoundList";
import { SettlementProgress, TechnicalDetails } from "./components/SettlementProgress";
import { MatchHeader } from "./components/MatchHeader";
import { Outcome } from "./components/Outcome";
import { Wager } from "./components/Wager";
import { StreamPicker, type StreamRow } from "./components/StreamPicker";
import { StakeMath } from "./components/StakeMath";
import { MatchEndCTA } from "./components/MatchEndCTA";
import { PredictedWager } from "./components/PredictedWager";
import { WorldIdGate, useIsWalletVerified } from "../../shared/worldid";

interface TxEvent {
  kind: TxKind;
  attempt: number;
  status: "pending" | "confirmed" | "failed";
  sig?: string;
  error?: string;
  ts: number;
}

type Role =
  | { kind: "loading" }
  | { kind: "needs-confirm"; snapshot: MatchSnapshot } // wallet not yet a participant; show join prompt
  | { kind: "playing"; you: Side };

export function Match() {
  const { id: matchId } = useParams<{ id: string }>();
  const { address: wallet } = useWalletAddress();

  const [role, setRole] = useState<Role>({ kind: "loading" });
  const [snap, setSnap] = useState<MatchSnapshot | null>(null);
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  const [joinErr, setJoinErr] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [joinerStream, setJoinerStream] = useState<StreamRow | null>(null);
  const [txEvents, setTxEvents] = useState<TxEvent[]>([]);
  const [roundDeadline, setRoundDeadline] = useState<number | null>(null);
  const [committedRound, setCommittedRound] = useState<number | null>(null);
  // Per-round outcome flash. Set when a round_result arrives where this client
  // won or lost (skipped on ties). Keyed by round so back-to-back results each
  // restart the animation; cleared on unmount of the round transition.
  const [flash, setFlash] = useState<{ kind: "win" | "loss"; key: number } | null>(null);
  const wsRef = useRef<WsClient | null>(null);
  // Per-round secret store for the commit-reveal flow. Lives only in this
  // tab's memory — a hard refresh between commit and reveal is treated as a
  // no-reveal forfeit by the server (same as ghosting after committing).
  const secretsRef = useRef<Map<number, { move: Move; nonce: string }>>(new Map());
  const verified = useIsWalletVerified(wallet);

  useEffect(() => {
    void api.getConfig().then(setCfg).catch(() => {});
  }, []);

  // When B joins, the server's `state` broadcast carries only the new state —
  // not B's wallet/stream. A's snapshot is stuck on playerB = null until we
  // refetch. Trigger off the first non-partnered state we see without B.
  useEffect(() => {
    if (!matchId || !snap) return;
    if (snap.state === "partnered" || snap.state === "queued") return;
    if (snap.playerB) return;
    void api.getMatch(matchId).then(setSnap).catch(() => {});
  }, [matchId, snap?.state, snap?.playerB]);

  // Step 1: classify role.
  useEffect(() => {
    if (!matchId || !wallet) return;
    if (role.kind !== "loading") return;
    void (async () => {
      try {
        const current = await api.getMatch(matchId);
        setSnap(current);
        if (current.playerA.wallet === wallet) {
          setRole({ kind: "playing", you: "a" });
        } else if (current.playerB?.wallet === wallet) {
          setRole({ kind: "playing", you: "b" });
        } else if (!current.playerB) {
          // Slot is open. Show join confirmation rather than auto-joining.
          setRole({ kind: "needs-confirm", snapshot: current });
        } else {
          throw new Error("Match is full and you are not a participant.");
        }
      } catch (e) {
        setJoinErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [matchId, wallet, role.kind]);

  async function confirmJoin() {
    if (!matchId || !wallet || role.kind !== "needs-confirm") return;
    if (!joinerStream) {
      setJoinErr("Pick a stream first");
      return;
    }
    setJoining(true);
    setJoinErr(null);
    try {
      await api.joinMatch(matchId, wallet, joinerStream.streamId);
      const refreshed = await api.getMatch(matchId);
      setSnap(refreshed);
      setRole({ kind: "playing", you: "b" });
    } catch (e) {
      setJoinErr(e instanceof Error ? e.message : String(e));
    } finally {
      setJoining(false);
    }
  }

  // Step 2: open WSS once we know our side AND have the operator's wsBase from
  // /api/config. The relative-path fallback in openWs would resolve to the FE
  // origin (vercel.app), which Vercel's rewrite can't proxy for WebSocket —
  // upgrades must connect directly to the operator host.
  useEffect(() => {
    if (!matchId || role.kind !== "playing" || !cfg?.wsBase) return;
    const you = role.you;
    const url = `${cfg.wsBase.replace(/\/$/, "")}/ws/match/${matchId}?as=${you}`;
    const ws = openWs(url, (frame) => {
      handleFrame(frame, you);
    });
    wsRef.current = ws;
    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId, role.kind === "playing" ? role.you : null, cfg?.wsBase]);

  function handleFrame(frame: ServerFrame, youSide: Side) {
    switch (frame.type) {
      case "hello":
        setSnap(frame.snapshot);
        break;
      case "state":
        setSnap((s) => (s ? { ...s, state: frame.state } : s));
        break;
      case "peer_status":
        setSnap((s) => {
          if (!s) return s;
          if (frame.peer === "a") return { ...s, playerA: { ...s.playerA, connected: frame.connected } };
          if (s.playerB) return { ...s, playerB: { ...s.playerB, connected: frame.connected } };
          return s;
        });
        break;
      case "round_start":
        setRoundDeadline(frame.deadline);
        setCommittedRound(null);
        setSnap((s) => (s ? { ...s, roundIndex: frame.round } : s));
        break;
      case "commits_locked": {
        // Both commits are in. Auto-send our reveal so the round resolves.
        // The deadline countdown in MoveButtons becomes irrelevant once both
        // sides have committed, so clear it.
        setRoundDeadline(null);
        const secret = secretsRef.current.get(frame.round);
        if (secret) {
          wsRef.current?.send({
            type: "reveal",
            round: frame.round,
            move: secret.move,
            nonce: secret.nonce,
          });
        }
        // If we don't have a secret, we never committed (or lost the secret to
        // a refresh). Server will time out our reveal and forfeit the round.
        break;
      }
      case "round_result":
        setRoundDeadline(null);
        setSnap((s) => {
          if (!s) return s;
          const r: RoundResult = {
            round: frame.round,
            a: youSide === "a" ? frame.yourMove : frame.theirMove,
            b: youSide === "b" ? frame.yourMove : frame.theirMove,
            winner: frame.winner,
            forfeitedBy: frame.forfeitedBy,
          };
          return { ...s, rounds: [...s.rounds, r] };
        });
        // Quick green/red flash. Ties get nothing — they're common in RPS and
        // a neutral flash would just be noise.
        if (youSide && frame.winner !== "tie") {
          setFlash({
            kind: frame.winner === youSide ? "win" : "loss",
            key: frame.round,
          });
        }
        // Round secret is no longer needed once the round has resolved.
        secretsRef.current.delete(frame.round);
        break;
      case "match_result":
        setSnap((s) => (s ? { ...s, winner: frame.winner, rounds: frame.rounds, state: "complete" } : s));
        break;
      case "tx":
        setTxEvents((prev) => [
          ...prev,
          { kind: frame.kind, attempt: frame.attempt, status: frame.status, sig: frame.sig, error: frame.error, ts: frame.ts },
        ]);
        break;
      case "done":
        setSnap((s) =>
          s ? { ...s, state: "done", signatures: frame.finalSignatures, winner: frame.winner } : s,
        );
        break;
      case "cancelled":
        setSnap((s) => (s ? { ...s, state: "cancelled" } : s));
        break;
      case "failed":
        setSnap((s) => (s ? { ...s, state: "failed", failedReason: frame.reason } : s));
        break;
      case "error":
        // fatal errors surface via state transitions; non-fatal are advisory only
        break;
    }
  }

  async function sendMove(move: Move) {
    if (!snap || !wsRef.current) return;
    const round = snap.roundIndex;
    if (committedRound === round) return;
    // Optimistically lock the buttons before the await so a double-click
    // can't fire two commits.
    setCommittedRound(round);
    try {
      const nonce = newNonce();
      const hash = await commitHash(move, nonce);
      secretsRef.current.set(round, { move, nonce });
      wsRef.current.send({ type: "commit", round, commitHash: hash });
    } catch (err) {
      // Hashing failed (extremely unlikely). Roll back so the user can retry.
      setCommittedRound(null);
      console.error("commit hash failed", err);
    }
  }

  const shareUrl = useMemo(() => `${location.origin}/match/${matchId}`, [matchId]);

  if (!matchId) return <div className="card error">Missing match id.</div>;
  if (!wallet) return <div className="card">Connect your wallet to view this match.</div>;
  if (joinErr) return <div className="card error">{joinErr}</div>;

  // Pre-join confirmation
  if (role.kind === "needs-confirm") {
    const s = role.snapshot;
    // Synthesize a playerB snapshot from the joiner's selected stream so
    // StakeMath can render the loss-side wager in token units symmetrically
    // with the win side. Server snapshot has no playerB yet (joiner hasn't
    // joined), but the joiner's StreamPicker selection has the data we need.
    const provisionalB: PlayerSlotSnapshot | null = joinerStream
      ? {
          wallet,
          streamId: joinerStream.streamId,
          connected: true,
          effectiveBps: joinerStream.effectiveBps ?? null,
          entitledLamports: null,
          lockedTokenAmount: joinerStream.lockedTokenAmount ?? null,
        }
      : null;
    return (
      <div className="match">
        <div className="card">
          <h1>You're about to join this match as Player B</h1>
          {s.verifiedOnly && (
            <div
              className="small"
              style={{
                display: "inline-block",
                marginTop: 4,
                padding: "2px 8px",
                borderRadius: 999,
                background: "#1f2937",
                color: "#a7f3d0",
                fontWeight: 600,
              }}
            >
              🌍 Verified players only — World ID required
            </div>
          )}
          <p className="dim small">
            Opponent: <code>{s.playerA.wallet.slice(0, 8)}…{s.playerA.wallet.slice(-4)}</code> ·
            stream <code>{s.playerA.streamId.slice(0, 8)}…</code>
          </p>
        </div>
        <Wager
          tokenMint={s.tokenMint}
          tokenMeta={s.tokenMeta}
          stakeBps={s.bpsAtStake}
          tokenEnv={cfg?.tokenEnv ?? "soldev"}
          wager={s.wager}
        />
        <StakeMath
          playerA={s.playerA}
          playerB={provisionalB}
          bpsAtStake={s.bpsAtStake}
          youSide="b"
          tokenMeta={s.tokenMeta}
          wager={s.wager}
        />
        <div className="card">
          <div className="form">
            <label>
              <span className="form__label">Your stream on this token</span>
              <StreamPicker
                wallet={wallet}
                tokenMint={s.tokenMint}
                tokenMeta={s.tokenMeta}
                value={joinerStream?.streamId ?? null}
                onChange={setJoinerStream}
              />
            </label>
          </div>
          {joinerStream && (
            <PredictedWager
              lockedA={s.playerA.lockedTokenAmount}
              lockedB={joinerStream.lockedTokenAmount}
              stakeBps={s.bpsAtStake}
              tokenMeta={s.tokenMeta}
              cohortMaxRatio={cfg?.cohortMaxRatio ?? 5}
            />
          )}
          {s.verifiedOnly && !verified ? (
            <WorldIdGate
              wallet={wallet}
              cfg={cfg}
              buttonLabel="Verify with World ID to join"
            >
              <button className="primary" onClick={confirmJoin} disabled={joining || !joinerStream}>
                {joining ? "Joining…" : "Confirm join"}
              </button>
            </WorldIdGate>
          ) : (
            <button className="primary" onClick={confirmJoin} disabled={joining || !joinerStream}>
              {joining ? "Joining…" : "Confirm join"}
            </button>
          )}
          <span className="dim small" style={{ marginLeft: 12 }}>
            By joining, you commit this stream to the match's stake.
          </span>
          {joinErr && <div className="error" style={{ marginTop: 8 }}>{joinErr}</div>}
        </div>
      </div>
    );
  }

  if (!snap || role.kind === "loading") return <div className="card">Loading match…</div>;

  const inPlay = snap.state === "active";
  const moved = committedRound === snap.roundIndex;
  const you = role.kind === "playing" ? role.you : null;

  return (
    <div className="match">
      {flash && (
        <div
          key={flash.key}
          className={`round-flash round-flash--${flash.kind}`}
          aria-hidden="true"
          onAnimationEnd={() => setFlash(null)}
        />
      )}
      <MatchHeader snap={snap} you={you} matchId={matchId} shareUrl={shareUrl} />

      <Wager
        tokenMint={snap.tokenMint}
        tokenMeta={snap.tokenMeta}
        stakeBps={snap.bpsAtStake}
        tokenEnv={cfg?.tokenEnv ?? "soldev"}
        wager={snap.wager}
        variant="compact"
      />

      {snap.playerB && (
        <StakeMath
          playerA={snap.playerA}
          playerB={snap.playerB}
          bpsAtStake={snap.bpsAtStake}
          youSide={you}
          tokenMeta={snap.tokenMeta}
          wager={snap.wager}
        />
      )}

      {(snap.state === "partnered" || snap.state === "creating") && (
        <div className="card">
          <h2>{snap.state === "partnered" ? "Waiting for opponent…" : "Creating session on-chain…"}</h2>
          <p className="dim small">
            Share this URL with your friend to have them join:
            <br />
            <code className="share-url">{shareUrl}</code>
          </p>
        </div>
      )}

      {inPlay && (
        <MoveButtons
          round={snap.roundIndex}
          deadline={roundDeadline}
          disabled={moved}
          onMove={sendMove}
        />
      )}

      <RoundList rounds={snap.rounds} you={you} />

      {snap.winner !== null && <Outcome snap={snap} you={you} />}

      {snap.state !== "active" &&
        snap.state !== "partnered" &&
        snap.state !== "creating" &&
        snap.state !== "done" && (
          <SettlementProgress snap={snap} you={you} txEvents={txEvents} cluster={cfg?.explorerCluster ?? "mainnet"} />
        )}

      {(snap.state === "done" || snap.state === "cancelled" || snap.state === "failed") && (
        <MatchEndCTA snap={snap} you={you} matchId={matchId} />
      )}

      {snap.state === "done" && (
        <TechnicalDetails
          signatures={snap.signatures}
          cluster={cfg?.explorerCluster ?? "mainnet"}
        />
      )}
    </div>
  );
}
