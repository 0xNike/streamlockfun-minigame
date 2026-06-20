import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useWalletAddress } from "../../shared/useWalletAddress";
import { api, type ServerConfig } from "../../shared/api";
import { openWs, type WsClient } from "../../shared/ws";
import type {
  GomokuSnapshot,
  MatchSnapshot,
  PlayerSlotSnapshot,
  ServerFrame,
  Side,
  TxKind,
} from "../../shared/types";
import { SettlementProgress, TechnicalDetails } from "../../shared/components/SettlementProgress";
import { MatchHeader } from "../../shared/components/MatchHeader";
import { Wager } from "../../shared/components/Wager";
import { StreamPicker, type StreamRow } from "../../shared/components/StreamPicker";
import { StakeMath } from "../../shared/components/StakeMath";
import { MatchEndCTA } from "../../shared/components/MatchEndCTA";
import { PredictedWager } from "../../shared/components/PredictedWager";
import { ResignButton } from "../../shared/components/ResignButton";
import { WorldIdGate, useIsWalletVerified } from "../../shared/worldid";
import { Board } from "./Board";

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
  | { kind: "spectator" } // no wallet, or a full match the wallet isn't part of — read-only
  | { kind: "needs-confirm"; snapshot: MatchSnapshot } // wallet not yet a participant; show join prompt
  | { kind: "playing"; you: Side };

const DEFAULT_SIZE = 15;

function emptyBoard(size: number): (Side | null)[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => null));
}

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
  // Gomoku play state, seeded from the GomokuSnapshot on `hello` and advanced by
  // gm_move / gm_turn frames. Kept locally so the grid updates immediately.
  const [size, setSize] = useState(DEFAULT_SIZE);
  const [board, setBoard] = useState<(Side | null)[][]>(() => emptyBoard(DEFAULT_SIZE));
  const [turn, setTurn] = useState<Side | null>(null);
  const [lastMove, setLastMove] = useState<{ x: number; y: number; by: Side } | null>(null);
  const [turnDeadline, setTurnDeadline] = useState<number | null>(null);
  const [, forceTick] = useState(0);
  const wsRef = useRef<WsClient | null>(null);
  const verified = useIsWalletVerified(wallet);
  // The wallet identity we last classified against, so the role re-resolves when
  // a spectator connects a wallet (undefined = not yet classified).
  const classifiedRef = useRef<string | null | undefined>(undefined);

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

  // Step 1: classify role. Runs without a wallet (→ spectator) and re-resolves
  // when the wallet identity changes, but never disrupts an in-progress join or
  // an active playing session.
  useEffect(() => {
    if (!matchId) return;
    if (role.kind === "needs-confirm" || role.kind === "playing") return;
    if (classifiedRef.current === (wallet ?? null)) return;
    classifiedRef.current = wallet ?? null;
    void (async () => {
      try {
        const current = await api.getMatch(matchId);
        setSnap(current);
        if (!wallet) {
          setRole({ kind: "spectator" });
        } else if (current.playerA.wallet === wallet) {
          setRole({ kind: "playing", you: "a" });
        } else if (current.playerB?.wallet === wallet) {
          setRole({ kind: "playing", you: "b" });
        } else if (!current.playerB) {
          // Slot is open. Show join confirmation rather than auto-joining.
          setRole({ kind: "needs-confirm", snapshot: current });
        } else {
          // Full match the wallet isn't part of → watch read-only.
          setRole({ kind: "spectator" });
        }
      } catch (e) {
        setJoinErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [matchId, wallet, role.kind]);

  // Spectators get no player WS (it requires ?as=a|b), so poll the public
  // snapshot for live-ish updates until the match reaches a terminal state, and
  // drive the board straight from the snapshot's gameState.
  useEffect(() => {
    if (role.kind !== "spectator" || !matchId) return;
    let stop = false;
    const id = setInterval(async () => {
      try {
        const s = await api.getMatch(matchId);
        if (stop) return;
        setSnap(s);
        if (s.state === "done" || s.state === "cancelled" || s.state === "failed") {
          clearInterval(id);
        }
      } catch {
        /* transient — retry next tick */
      }
    }, 2000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [role.kind, matchId]);

  // Spectator board comes from the polled snapshot, not WS frames.
  useEffect(() => {
    if (role.kind !== "spectator") return;
    seedFromGameState((snap?.gameState as GomokuSnapshot | null) ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role.kind, snap]);

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
      handleFrame(frame);
    });
    wsRef.current = ws;
    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId, role.kind === "playing" ? role.you : null, cfg?.wsBase]);

  // Re-render once a second so the deadline countdown stays live.
  useEffect(() => {
    if (turnDeadline === null) return;
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [turnDeadline]);

  function seedFromGameState(gs: GomokuSnapshot | null) {
    if (!gs || gs.kind !== "gomoku") return;
    setSize(gs.size);
    setBoard(gs.board.map((row) => row.slice()));
    setTurn(gs.turn);
    setLastMove(gs.lastMove);
  }

  function handleFrame(frame: ServerFrame) {
    switch (frame.type) {
      case "hello":
        setSnap(frame.snapshot);
        seedFromGameState(frame.snapshot.gameState as GomokuSnapshot | null);
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
      case "gm_move":
        setBoard((b) => {
          const next = b.map((row) => row.slice());
          if (next[frame.y]) next[frame.y][frame.x] = frame.by;
          return next;
        });
        setLastMove({ x: frame.x, y: frame.y, by: frame.by });
        break;
      case "gm_turn":
        setTurn(frame.turn);
        setTurnDeadline(frame.deadline);
        break;
      case "match_result":
        setTurnDeadline(null);
        setSnap((s) => (s ? { ...s, winner: frame.winner, state: "complete" } : s));
        break;
      case "tx":
        setTxEvents((prev) => [
          ...prev,
          { kind: frame.kind, attempt: frame.attempt, status: frame.status, sig: frame.sig, error: frame.error, ts: frame.ts },
        ]);
        break;
      case "done":
        setTurnDeadline(null);
        setSnap((s) =>
          s ? { ...s, state: "done", signatures: frame.finalSignatures, winner: frame.winner } : s,
        );
        break;
      case "cancelled":
        setTurnDeadline(null);
        setSnap((s) => (s ? { ...s, state: "cancelled" } : s));
        break;
      case "failed":
        setTurnDeadline(null);
        setSnap((s) => (s ? { ...s, state: "failed", failedReason: frame.reason } : s));
        break;
      case "error":
        // fatal errors surface via state transitions; non-fatal are advisory only
        break;
    }
  }

  function placeStone(x: number, y: number) {
    wsRef.current?.send({ type: "place", x, y });
  }

  const shareUrl = useMemo(() => `${location.origin}/match/${matchId}`, [matchId]);

  if (!matchId) return <div className="card error">Missing match id.</div>;
  if (joinErr) return <div className="card error">{joinErr}</div>;

  // Pre-join confirmation
  if (role.kind === "needs-confirm") {
    if (!wallet) return null; // role is only "needs-confirm" with a wallet; narrows the type
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
  const you = role.kind === "playing" ? role.you : null;
  const yourTurn = inPlay && you !== null && turn === you;
  const spectating = role.kind === "spectator";
  const turnLabel = spectating
    ? turn
      ? `Player ${turn === "a" ? "A" : "B"} to move`
      : "—"
    : yourTurn
      ? "Your move"
      : "Opponent's move";

  return (
    <div className="match">
      <MatchHeader snap={snap} you={you} matchId={matchId} shareUrl={shareUrl} />

      {spectating && (
        <div className="card spectator-note">
          <span className="dim small">
            Spectating —{" "}
            {snap.playerB
              ? "connect a wallet to start your own match."
              : "connect a wallet to join this match."}
          </span>
        </div>
      )}

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
        <div className="card gomoku-play">
          <div className="gomoku-status">
            <span className={`gomoku-turn ${yourTurn ? "gomoku-turn--you" : "gomoku-turn--opp"}`}>
              {turnLabel}
            </span>
            <TurnCountdown deadline={turnDeadline} />
          </div>
          <Board
            size={size}
            board={board}
            you={you}
            lastMove={lastMove}
            interactive={yourTurn}
            onPlace={placeStone}
          />
          <p className="dim small gomoku-hint">
            {spectating
              ? "You're watching this match live. First to five in a row wins."
              : yourTurn
                ? "Tap an empty spot to place your stone. First to five in a row wins."
                : "Waiting for your opponent to move."}
          </p>
          {you !== null && (
            <div className="resign-row">
              <ResignButton onResign={() => wsRef.current?.send({ type: "forfeit" })} />
            </div>
          )}
        </div>
      )}

      {snap.winner !== null && <GomokuOutcome snap={snap} you={you} />}

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

/** Live mm:ss countdown to a deadline (epoch seconds, matching the server's
 *  nowSec() clock — same convention RPS uses). Goes amber under 10s. */
function TurnCountdown({ deadline }: { deadline: number | null }) {
  if (deadline === null) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  const totalSec = Math.max(0, deadline - nowSec);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  const danger = totalSec <= 10;
  return (
    <span className={`countdown ${danger ? "danger" : ""}`}>
      {mm}:{ss.toString().padStart(2, "0")}
    </span>
  );
}

/** Win/loss/tie hero for Gomoku, mirroring the RPS Outcome's color contract. */
function GomokuOutcome({ snap, you }: { snap: MatchSnapshot; you: Side | null }) {
  const winner = snap.winner;
  if (!winner) return null;

  if (winner === "tie") {
    return (
      <div className="hero hero--tie">
        <div className="hero__verdict">It's a draw</div>
        <div className="hero__sub">
          No five in a row. Your match is being cancelled and any setup costs refunded.
        </div>
      </div>
    );
  }

  const youWon = you === winner;
  const winnerSlot = winner === "a" ? snap.playerA : snap.playerB;
  const loserSlot = winner === "a" ? snap.playerB : snap.playerA;

  return (
    <div className={`hero ${youWon ? "hero--win" : "hero--loss"}`}>
      <div className="hero__verdict">{youWon ? "🏆 You won!" : "💀 You lost"}</div>
      <div className="hero__sub">
        {youWon ? (
          <>
            You got five in a row
            {loserSlot && (
              <>
                {" "}against{" "}
                <code>
                  {loserSlot.wallet.slice(0, 6)}…{loserSlot.wallet.slice(-4)}
                </code>
              </>
            )}
            .
          </>
        ) : (
          <>
            {winnerSlot && (
              <>
                <code>
                  {winnerSlot.wallet.slice(0, 6)}…{winnerSlot.wallet.slice(-4)}
                </code>{" "}
              </>
            )}
            got five in a row first.
          </>
        )}
      </div>
    </div>
  );
}
