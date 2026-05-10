import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useNavigate } from "react-router-dom";
import { api, type ServerConfig } from "../api";
import { Wager } from "../components/Wager";
import { StreamPicker } from "../components/StreamPicker";
import { WagerInput, type WagerInputResult } from "../components/WagerInput";

interface PickedStream {
  streamId: string;
  effectiveBps?: number | null;
  lockedTokenAmount?: string | null;
}

export function Home() {
  const { publicKey } = useWallet();
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [picked, setPicked] = useState<PickedStream | null>(null);
  const [wagerResult, setWagerResult] = useState<WagerInputResult>({ status: "empty" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cfg, setCfg] = useState<ServerConfig | null>(null);

  useEffect(() => {
    void api
      .getConfig()
      .then(setCfg)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  // Default wager amount = stakeBps × yourLocked / 10000. The server clamps it
  // to min(P1.locked, P2.locked) at B-join, so this is a "suggested cap" — the
  // actual settled amount may be smaller if the joiner has less locked.
  const defaultAmountRaw = useMemo(() => {
    if (!cfg || !picked?.lockedTokenAmount) return null;
    try {
      return ((BigInt(picked.lockedTokenAmount) * BigInt(cfg.stakeBps)) / 10000n).toString();
    } catch {
      return null;
    }
  }, [cfg, picked?.lockedTokenAmount]);

  async function createMatch() {
    if (!publicKey) {
      setErr("Connect a wallet first");
      return;
    }
    if (!picked) {
      setErr("Pick a stream");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const wallet = publicKey.toBase58();
      const { matchId } = await api.createMatch({
        wallet,
        streamId: picked.streamId,
        wagerAmountRaw: wagerResult.status === "ok" ? wagerResult.amountRaw : undefined,
      });
      navigate(`/match/${matchId}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function joinByCode() {
    const trimmed = code.trim();
    if (!trimmed) return;
    navigate(`/match/${trimmed}`);
  }

  const wallet = publicKey?.toBase58() ?? null;
  const wagerOk =
    !picked?.lockedTokenAmount || // legacy stream — server falls back to bps path
    wagerResult.status === "ok";
  const ready = !!wallet && !!cfg && !!picked && wagerOk;

  return (
    <>
      {cfg && (
        <Wager
          tokenMint={cfg.tokenMint}
          tokenMeta={cfg.tokenMeta}
          stakeBps={cfg.stakeBps}
          tokenEnv={cfg.tokenEnv}
        />
      )}
      <div className="card">
        <h1>Create a match</h1>
        {!publicKey && <p className="dim">Connect your wallet to begin.</p>}
        <div className="form">
          <label>
            <span className="form__label">Your stream</span>
            <StreamPicker
              wallet={wallet}
              tokenMint={cfg?.tokenMint ?? null}
              tokenMeta={cfg?.tokenMeta ?? null}
              value={picked?.streamId ?? null}
              onChange={(s) => setPicked(s)}
            />
          </label>
        </div>

        {picked?.lockedTokenAmount && cfg?.tokenMeta && defaultAmountRaw && (
          <WagerInput
            lockedTokenAmount={picked.lockedTokenAmount}
            tokenMeta={cfg.tokenMeta}
            defaultAmountRaw={defaultAmountRaw}
            onChange={setWagerResult}
          />
        )}
        {picked && !picked.lockedTokenAmount && (
          <div className="dim small" style={{ marginBottom: 12 }}>
            Legacy stream — wager defaults to {(cfg?.stakeBps ?? 0) / 100}% of the loser's stream
            (no absolute amount available).
          </div>
        )}

        <div className="row">
          <button onClick={createMatch} disabled={!ready || busy} className="primary">
            {busy ? "Creating…" : "Create new match"}
          </button>
        </div>
        <div className="divider">or</div>
        <div className="row">
          <input
            placeholder="paste match id"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            spellCheck={false}
          />
          <button onClick={joinByCode} disabled={!code.trim()}>
            Join
          </button>
        </div>
        {err && <div className="error">{err}</div>}
        <div className="dim small">
          Match URLs are shareable. After creating a match, copy the URL and send it to your friend.
        </div>
      </div>
    </>
  );
}
