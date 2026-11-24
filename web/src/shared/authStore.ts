/**
 * Wallet sign-in token (issued by POST /api/auth/verify after the player signs
 * a one-time message). Sent as `Authorization: Bearer` on create/join and as
 * `?token=` on the match WebSocket. Kept in sessionStorage per wallet so a
 * refresh doesn't force a re-sign; it dies with the tab.
 */

const KEY = "sl_auth_v1";

type Stored = { wallet: string; token: string; exp: number };

let current: Stored | null = (() => {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
})();

const nowSec = () => Math.floor(Date.now() / 1000);

/** Token for `wallet` if we hold a valid one (with a 60 s safety margin). */
export function tokenFor(wallet: string | null | undefined): string | null {
  if (!wallet || !current || current.wallet !== wallet) return null;
  return current.exp - 60 > nowSec() ? current.token : null;
}

/** Whatever valid token we hold (used by the WS client, which has no wallet in scope). */
export function currentToken(): string | null {
  return current && current.exp - 60 > nowSec() ? current.token : null;
}

export function setToken(s: Stored): void {
  current = s;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode: memory only */
  }
}

export function clearToken(): void {
  current = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
