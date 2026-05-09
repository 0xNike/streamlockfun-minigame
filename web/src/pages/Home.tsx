import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useNavigate } from "react-router-dom";
import { api, type ServerConfig } from "../api";
import { Wager } from "../components/Wager";
import { StreamPicker } from "../components/StreamPicker";

export function Home() {
  const { publicKey } = useWallet();
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [streamId, setStreamId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cfg, setCfg] = useState<ServerConfig | null>(null);

  useEffect(() => {
    void api
      .getConfig()
      .then(setCfg)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  async function createMatch() {
    if (!publicKey) {
      setErr("Connect a wallet first");
      return;
    }
    if (!streamId) {
      setErr("Pick a stream");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const wallet = publicKey.toBase58();
      const { matchId } = await api.createMatch({ wallet, streamId });
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
  const ready = !!wallet && !!cfg && !!streamId;

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
              value={streamId}
              onChange={setStreamId}
            />
          </label>
        </div>
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
