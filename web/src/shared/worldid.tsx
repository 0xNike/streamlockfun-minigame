/**
 * Client-side World ID gate.
 *
 * <WorldIdGate wallet={...}> wraps a CTA. If the wallet already has a valid
 * wid_session cookie (verified by `/api/worldid/me`), it renders `children`.
 * Otherwise it shows a "Verify with World ID" button that opens the IDKit
 * widget, posts the resulting proof to `/api/worldid/verify`, and re-checks.
 *
 * `useWorldId()` exposes the same state for callers that need to react to
 * verification outside the gate (e.g. a "Verified ✓" badge).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  IDKitRequestWidget,
  IDKitErrorCodes,
  orbLegacy,
  setDebug,
  type IDKitResult,
  type RpContext,
} from "@worldcoin/idkit";

// Verbose IDKit logging in dev — surfaces the underlying connector API
// response when generic_error fires, which is much more actionable than
// the surfaced error code alone.
if (typeof window !== "undefined" && import.meta.env.DEV) setDebug(true);
import { api, type ServerConfig } from "./api";

type Status =
  | { kind: "loading" }
  | { kind: "verified"; wallet: string; nullifier: string; exp: number }
  | { kind: "unverified" };

type Ctx = {
  status: Status;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

const WorldIdCtx = createContext<Ctx | null>(null);

export function WorldIdProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  const refresh = useCallback(async () => {
    try {
      const me = await api.worldid.me();
      setStatus(
        me.verified
          ? { kind: "verified", wallet: me.wallet, nullifier: me.nullifier, exp: me.exp }
          : { kind: "unverified" },
      );
    } catch {
      setStatus({ kind: "unverified" });
    }
  }, []);

  const logout = useCallback(async () => {
    await api.worldid.logout();
    setStatus({ kind: "unverified" });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<Ctx>(() => ({ status, refresh, logout }), [status, refresh, logout]);
  return <WorldIdCtx.Provider value={value}>{children}</WorldIdCtx.Provider>;
}

export function useWorldId(): Ctx {
  const ctx = useContext(WorldIdCtx);
  if (!ctx) throw new Error("useWorldId must be used within <WorldIdProvider>");
  return ctx;
}

/** Returns true iff the active session matches `wallet`. Loading state → false. */
export function useIsWalletVerified(wallet: string | null | undefined): boolean {
  const { status } = useWorldId();
  return !!wallet && status.kind === "verified" && status.wallet === wallet;
}

interface GateProps {
  wallet: string;
  cfg: ServerConfig | null;
  /** What to render when the wallet is verified (the actual CTA, e.g. <button>Join</button>). */
  children: ReactNode;
  /** Optional copy on the gate's primary button. Defaults to "Verify with World ID". */
  buttonLabel?: string;
  /** Optional className passed to the gate wrapper for layout. */
  className?: string;
}

/**
 * Render-prop pattern: pass the CTA (button, etc.) as children. We only show it
 * when the cookie is good. Until then we render the verify button which opens
 * the IDKit widget.
 */
export function WorldIdGate({ wallet, cfg, children, buttonLabel, className }: GateProps) {
  const { status, refresh } = useWorldId();
  const [open, setOpen] = useState(false);
  const [rpContext, setRpContext] = useState<RpContext | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const verified = status.kind === "verified" && status.wallet === wallet;

  if (status.kind === "loading") {
    return <div className={className}><span className="dim small">Checking verification…</span></div>;
  }
  if (verified) return <>{children}</>;

  // World ID isn't configured server-side at all — surface that to the user
  // and let them carry on with whatever non-verified path the parent intended.
  if (!cfg || !cfg.worldId.enabled) {
    return (
      <div className={className}>
        <div className="error small">
          World ID isn't configured on this server. Verified-only matches are unavailable.
        </div>
      </div>
    );
  }

  async function startVerify() {
    setErr(null);
    setBusy(true);
    try {
      const ctx = await api.worldid.context(wallet);
      // Strip our extra fields; pass only what RpContext actually needs.
      setRpContext({
        rp_id: ctx.rp_id,
        nonce: ctx.nonce,
        created_at: ctx.created_at,
        expires_at: ctx.expires_at,
        signature: ctx.signature,
      });
      setOpen(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify(result: IDKitResult) {
    // Forward proof to the operator backend, which forwards byte-for-byte to
    // the developer-portal verify endpoint. Throwing here keeps the IDKit
    // widget open so the user can retry.
    try {
      await api.worldid.verify(wallet, result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      throw e;
    }
  }

  async function onSuccess() {
    await refresh();
    setOpen(false);
    setRpContext(null);
  }

  function onError(code: IDKitErrorCodes) {
    // World App sends a generic "Something went wrong" popup but the actual
    // failure mode lives in this code. Surface it so we can debug.
    setErr(`World ID error: ${code}`);
    console.error("[WorldIdGate] IDKit error", code);
  }

  if (!cfg.worldId.enabled) return null; // narrow for TS — handled above
  const wid = cfg.worldId;

  return (
    <div className={className}>
      <button type="button" onClick={startVerify} disabled={busy} className="primary">
        {busy ? "Loading…" : (buttonLabel ?? "Verify with World ID")}
      </button>
      {err && <div className="error small" style={{ marginTop: 8 }}>{err}</div>}
      {rpContext && (
        <IDKitRequestWidget
          app_id={wid.appId as `app_${string}`}
          action={wid.action}
          rp_context={rpContext}
          environment={wid.environment}
          allow_legacy_proofs={true}
          preset={orbLegacy({ signal: wallet })}
          open={open}
          onOpenChange={setOpen}
          handleVerify={handleVerify}
          onSuccess={onSuccess}
          onError={onError}
        />
      )}
    </div>
  );
}
