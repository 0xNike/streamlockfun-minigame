import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useWalletAddress } from "../../shared/useWalletAddress";
import { api, type ServerConfig } from "../../shared/api";
import { openWs, type WsClient } from "../../shared/ws";
import type {
  ChessSnapshot,
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
import { START_FEN } from "./rules";

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
  | { kind: "spectator" }
  | { kind: "needs-confirm"; snapshot: MatchSnapshot }
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
  // Chess play state, seeded from the ChessSnapshot on `hello` and advanced by
  // ch_move / ch_turn frames. FEN is the single source of truth for the board.
  const [fen, setFen] = useState<string>(START_FEN);
  const [turn, setTurn] = useState<Side | null>(null);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const [check, setCheck] = useState(false);
  const [turnDeadline, setTurnDeadline] = useState<number | null>(null);
  const [, forceTick] = useState(0);
  const wsRef = useRef<WsClient | null>(null);
  const verified = useIsWalletVerified(wallet);
  const classifiedRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    void api.getConfig().then(setCfg).catch(() => {});
  }, []);

  useEffect(() => {
    if (!matchId || !snap) return;
    if (snap.state === "partnered" || snap.state === "queued") return;
    if (snap.playerB) return;
    void api.getMatch(matchId).then(setSnap).catch(() => {});
  }, [matchId, snap?.state, snap?.playerB]);

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
          setRole({ kind: "needs-confirm", snapshot: current });
        } else {
          setRole({ kind: "spectator" });
        }
      } catch (e) {
        setJoinErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [matchId, wallet, role.kind]);

  // Spectators poll the public snapshot and drive the board from its gameState.
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

  useEffect(() => {
    if (role.kind !== "spectator") return;
    seedFromGameState((snap?.gameState as ChessSnapshot | null) ?? null);
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

  useEffect(() => {
    if (!matchId || role.kind !== "playing" || !cfg?.wsBase) return;
    const you = role.you;
    const url = `${cfg.wsBase.replace(/\/$/, "")}/ws/match/${matchId}?as=${you}`;
    const ws = openWs(url, (frame) => handleFrame(frame));
    wsRef.current = ws;
    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId, role.kind === "playing" ? role.you : null, cfg?.wsBase]);

  useEffect(() => {
    if (turnDeadline === null) return;
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [turnDeadline]);

  function seedFromGameState(gs: ChessSnapshot | null) {
    if (!gs || gs.kind !== "chess") return;
    setFen(gs.fen);
    setTurn(gs.turn);
    setLastMove(gs.lastMove);
    setCheck(gs.check);
  }

  function handleFrame(frame: ServerFrame) {
    switch (frame.type) {
      case "hello":
        setSnap(frame.snapshot);
        seedFromGameState(frame.snapshot.gameState as ChessSnapshot | null);
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
      case "ch_move":
        setFen(frame.fen);
        setLastMove({ from: frame.from, to: frame.to });
        setCheck(frame.check);
        break;
      case "ch_turn":
        setTurn(frame.turn);
        setTurnDeadline(frame.deadline);
        setCheck(frame.check);
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
        break;
    }
  }

  function sendMove(from: string, to: string, promotion?: "q" | "r" | "b" | "n") {
    wsRef.current?.send({ type: "chess_move", from, to, promotion });
  }

  const shareUrl = useMemo(() => `${location.origin}/match/${matchId}`, [matchId]);

  const youSide = role.kind === "playing" ? role.you : null;

  if (!matchId) return <div className="card error">Missing match id.</div>;
  if (joinErr) return <div className="card error">{joinErr}</div>;

  // Pre-join confirmation
  if (role.kind === "needs-confirm") {
    if (!wallet) return null;
    const s = role.snapshot;
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
          <h1>You're about to join this match as Black</h1>
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
              Verified players only — World ID required
            </div>
          )}
          <p className="dim small">
            Opponent (White): <code>{s.playerA.wallet.slice(0, 8)}…{s.playerA.wallet.slice(-4)}</code> ·
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
            <WorldIdGate wallet={wallet} cfg={cfg} buttonLabel="Verify with World ID to join">
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
      ? `${turn === "a" ? "White" : "Black"} to move`
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
        <div className="card chess-play">
          <div className="chess-status">
            <span className={`chess-turn ${yourTurn ? "chess-turn--you" : "chess-turn--opp"}`}>
              {turnLabel}
            </span>
            {check && <span className="chess-check">Check</span>}
            <TurnCountdown deadline={turnDeadline} />
          </div>
          <Board
            fen={fen}
            youSide={youSide}
            interactive={yourTurn}
            lastMove={lastMove}
            check={check}
            onMove={sendMove}
          />
          <p className="dim small chess-hint">
            {spectating
              ? "You're watching this match live. Checkmate wins; a draw refunds both stakes."
              : yourTurn
                ? "Tap a piece, then a highlighted square. Checkmate wins the stake."
                : "Waiting for your opponent to move."}
          </p>
          {you !== null && (
            <div className="resign-row">
              <ResignButton onResign={() => wsRef.current?.send({ type: "forfeit" })} />
            </div>
          )}
        </div>
      )}

      {snap.winner !== null && <ChessOutcome snap={snap} you={you} />}

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
        <TechnicalDetails signatures={snap.signatures} cluster={cfg?.explorerCluster ?? "mainnet"} />
      )}
    </div>
  );
}

/** Live mm:ss countdown to a deadline (epoch seconds). Goes amber under 10s. */
function TurnCountdown({ deadline }: { deadline: number | null }) {
  if (deadline === null) return null;
  const totalSec = Math.max(0, deadline - Math.floor(Date.now() / 1000));
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return (
    <span className={`countdown ${totalSec <= 10 ? "danger" : ""}`}>
      {mm}:{ss.toString().padStart(2, "0")}
    </span>
  );
}

/** Win/loss/draw hero. Checkmate/resign/timeout → win or loss; any draw → tie. */
function ChessOutcome({ snap, you }: { snap: MatchSnapshot; you: Side | null }) {
  const winner = snap.winner;
  if (!winner) return null;

  if (winner === "tie") {
    return (
      <div className="hero hero--tie">
        <div className="hero__verdict">Draw</div>
        <div className="hero__sub">
          Neither side wins — the match is being cancelled and any setup costs refunded.
        </div>
      </div>
    );
  }

  const youWon = you === winner;
  const winnerSlot = winner === "a" ? snap.playerA : snap.playerB;
  const loserSlot = winner === "a" ? snap.playerB : snap.playerA;
  const short = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`;

  return (
    <div className={`hero ${youWon ? "hero--win" : "hero--loss"}`}>
      <div className="hero__verdict">{youWon ? "You won" : "You lost"}</div>
      <div className="hero__sub">
        {youWon ? (
          <>Checkmate{loserSlot && <> against <code>{short(loserSlot.wallet)}</code></>}. The stake is yours.</>
        ) : (
          <>{winnerSlot && <><code>{short(winnerSlot.wallet)}</code> </>}won the match.</>
        )}
      </div>
    </div>
  );
}
