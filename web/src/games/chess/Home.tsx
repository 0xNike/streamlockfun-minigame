import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useWalletAddress } from "../../shared/useWalletAddress";
import { api, type ServerConfig } from "../../shared/api";
import { Wager } from "../../shared/components/Wager";
import { StreamPicker } from "../../shared/components/StreamPicker";
import { WagerInput, type WagerInputResult } from "../../shared/components/WagerInput";
import { WorldIdGate, useIsWalletVerified, useWorldId } from "../../shared/worldid";

interface PickedStream {
  streamId: string;
  effectiveBps?: number | null;
  lockedTokenAmount?: string | null;
}

export function Home() {
  const { address: wallet } = useWalletAddress();
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [picked, setPicked] = useState<PickedStream | null>(null);
  const [wagerResult, setWagerResult] = useState<WagerInputResult>({ status: "empty" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const verified = useIsWalletVerified(wallet);
  const { logout } = useWorldId();

  useEffect(() => {
    void api
      .getConfig()
      .then(setCfg)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const defaultAmountRaw = useMemo(() => {
    if (!cfg || !picked?.lockedTokenAmount) return null;
    try {
      return ((BigInt(picked.lockedTokenAmount) * BigInt(cfg.stakeBps)) / 10000n).toString();
    } catch {
      return null;
    }
  }, [cfg, picked?.lockedTokenAmount]);

  async function createMatch() {
    if (!wallet) {
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
      const { matchId } = await api.createMatch({
        wallet,
        streamId: picked.streamId,
        wagerAmountRaw: wagerResult.status === "ok" ? wagerResult.amountRaw : undefined,
        verifiedOnly,
        gameId: "chess",
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

  const wagerOk = !picked?.lockedTokenAmount || wagerResult.status === "ok";
  const worldIdOk = !verifiedOnly || verified;
  const ready = !!wallet && !!cfg && !!picked && wagerOk && worldIdOk;
  const worldIdEnabled = cfg?.worldId.enabled === true;
  const stakePct = ((cfg?.stakeBps ?? 1000) / 100).toFixed(0);

  return (
    <>
      <section className="intro" aria-labelledby="intro-title">
        <h1 id="intro-title" className="intro__title">Chess</h1>
        <p className="intro__sub">
          Standard chess, 1v1, 60s per move. Checkmate (or your opponent resigning / timing out)
          takes the {stakePct}% stake; a draw cancels the match and refunds both sides.
        </p>
      </section>
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
        {!wallet && <p className="dim">Connect your wallet to begin.</p>}
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

        {worldIdEnabled && (
          <div className="row" style={{ alignItems: "center", gap: 12, marginBottom: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={verifiedOnly}
                onChange={(e) => setVerifiedOnly(e.target.checked)}
              />
              <span>Verified players only (World ID)</span>
            </label>
            {verified && (
              <span className="dim small" title="This wallet is bound to a verified human via World ID">
                verified ·{" "}
                <button
                  type="button"
                  onClick={() => void logout()}
                  className="link"
                  style={{ background: "none", border: 0, padding: 0, cursor: "pointer", textDecoration: "underline" }}
                >
                  unbind
                </button>
              </span>
            )}
          </div>
        )}

        {verifiedOnly && !verified && wallet ? (
          <div className="row">
            <WorldIdGate wallet={wallet} cfg={cfg} buttonLabel="Verify with World ID to create">
              <button onClick={createMatch} disabled={!ready || busy} className="primary">
                {busy ? "Creating…" : "Create new match"}
              </button>
            </WorldIdGate>
          </div>
        ) : (
          <div className="row">
            <button onClick={createMatch} disabled={!ready || busy} className="primary">
              {busy ? "Creating…" : "Create new match"}
            </button>
          </div>
        )}
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
