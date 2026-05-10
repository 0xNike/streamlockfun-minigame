/**
 * Amount-first wager input.
 *
 * The user types an absolute amount of token; the component reports the raw
 * u64 base-unit string (BigInt-safe) plus a validation status. Helper text
 * shows the floor (smallest amount that produces ≥1 bps), the cap (their
 * holding), and the bps equivalent in real time.
 *
 * Validation done client-side is best-effort — the server re-validates with
 * the joiner's locked amount baked in (which we don't know at create time).
 * The "above-cap" rule shown here is the user's *own* locked amount; the
 * actual cap may be tighter once an opponent joins.
 */

import { useEffect, useMemo, useState } from "react";
import type { TokenMetaPublic } from "../types";
import { formatToken, parseHumanToken } from "../format";

export type WagerInputResult =
  | { status: "ok"; amountRaw: string; bpsOfMyStream: number }
  | { status: "empty" }
  | { status: "invalid" }
  | { status: "below-floor"; floorRaw: string }
  | { status: "above-cap"; capRaw: string };

export function WagerInput({
  lockedTokenAmount,
  tokenMeta,
  defaultAmountRaw,
  onChange,
}: {
  /** The user's own stream's locked amount in raw base units. Drives floor/cap. */
  lockedTokenAmount: string;
  tokenMeta: TokenMetaPublic | null;
  /** Pre-fill amount in raw base units. Typically `stakeBps × locked / 10000`. */
  defaultAmountRaw: string;
  onChange: (result: WagerInputResult) => void;
}) {
  const decimals = tokenMeta?.decimals ?? null;
  const symbol = tokenMeta?.symbol ?? "";

  const [text, setText] = useState(() => defaultDisplay(defaultAmountRaw, decimals));

  // Reset display when the underlying defaults change (e.g. user picks a different stream).
  useEffect(() => {
    setText(defaultDisplay(defaultAmountRaw, decimals));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultAmountRaw, decimals]);

  const lockedBig = useMemo(() => safeBigInt(lockedTokenAmount), [lockedTokenAmount]);
  const floor = useMemo(() => (lockedBig ? (lockedBig + 9999n) / 10000n : null), [lockedBig]);
  const cap = lockedBig;

  const result = useMemo<WagerInputResult>(() => {
    if (text.trim() === "") return { status: "empty" };
    const raw = parseHumanToken(text, decimals);
    if (raw === null || raw <= 0n) return { status: "invalid" };
    if (floor !== null && raw < floor) {
      return { status: "below-floor", floorRaw: floor.toString() };
    }
    if (cap !== null && raw > cap) {
      return { status: "above-cap", capRaw: cap.toString() };
    }
    const bps = lockedBig && lockedBig > 0n ? Number((raw * 10000n) / lockedBig) : 0;
    return { status: "ok", amountRaw: raw.toString(), bpsOfMyStream: bps };
  }, [text, decimals, floor, cap, lockedBig]);

  useEffect(() => {
    onChange(result);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result.status, "amountRaw" in result ? result.amountRaw : null]);

  const floorTokens = floor ? formatToken(floor, decimals, symbol || null) : null;
  const capTokens = cap ? formatToken(cap, decimals, symbol || null) : null;

  return (
    <div className="wager-input">
      <label className="wager-input__field">
        <span className="form__label">Wager amount</span>
        <div className="wager-input__row">
          <input
            type="text"
            inputMode="decimal"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={floorTokens ? `min ${floorTokens}` : "amount"}
            spellCheck={false}
            aria-invalid={result.status !== "ok" && result.status !== "empty"}
          />
          {symbol && <span className="wager-input__suffix">{symbol}</span>}
        </div>
      </label>

      <div className="wager-input__hints">
        {result.status === "ok" && (
          <span className="dim small">
            That's <strong>{(result.bpsOfMyStream / 100).toFixed(2)}%</strong> of your stream.
            Opponent matches the same absolute amount, capped to their stream size.
          </span>
        )}
        {result.status === "empty" && (
          <span className="dim small">
            {floorTokens && <>Min {floorTokens}</>}
            {floorTokens && capTokens && <> · </>}
            {capTokens && <>max {capTokens}</>}
          </span>
        )}
        {result.status === "invalid" && (
          <span className="error small">Enter a positive amount.</span>
        )}
        {result.status === "below-floor" && (
          <span className="error small">
            Below minimum {floorTokens ?? "1 base unit"}. Anything smaller rounds to zero on-chain.
          </span>
        )}
        {result.status === "above-cap" && (
          <span className="error small">
            Above your holdings ({capTokens ?? "your max"}). Lower the amount.
          </span>
        )}
      </div>
    </div>
  );
}

function defaultDisplay(amountRaw: string, decimals: number | null): string {
  const big = safeBigInt(amountRaw);
  if (big === null) return "";
  const formatted = formatToken(big, decimals, null);
  if (formatted === null) return "";
  return formatted.replace(/,/g, "");
}

function safeBigInt(s: string): bigint | null {
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}
