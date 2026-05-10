/**
 * BigInt-safe token formatters.
 *
 * `lockedTokenAmount` arrives as a decimal string (raw u64 base units). We
 * never coerce to Number — fits-in-Number is not guaranteed for u64. Math is
 * BigInt; only the final display step touches strings.
 */

export function stakeBaseUnits(
  lockedTokenAmount: string | null | undefined,
  stakeBps: number,
): bigint | null {
  if (!lockedTokenAmount) return null;
  try {
    return (BigInt(lockedTokenAmount) * BigInt(stakeBps)) / 10000n;
  } catch {
    return null;
  }
}

/**
 * Render `amountBaseUnits` (a bigint) using the token's `decimals`.
 * - decimals null/undefined → returns `"12345 base units"` (or with symbol if given).
 * - amount null → returns null so callers can fall back to bps copy.
 * - Shows up to `maxFractionDigits` (default 6); strips trailing zeros.
 */
export function formatToken(
  amountBaseUnits: bigint | null,
  decimals: number | null | undefined,
  symbol: string | null | undefined,
  maxFractionDigits = 6,
): string | null {
  if (amountBaseUnits === null) return null;

  const sym = symbol ?? "";
  if (decimals === null || decimals === undefined) {
    const raw = formatThousands(amountBaseUnits.toString());
    return sym ? `${raw} ${sym} (base units)` : `${raw} base units`;
  }

  const negative = amountBaseUnits < 0n;
  const abs = negative ? -amountBaseUnits : amountBaseUnits;
  const divisor = 10n ** BigInt(decimals);
  const intPart = abs / divisor;
  const fracPart = abs % divisor;

  let intStr = formatThousands(intPart.toString());
  if (negative) intStr = `-${intStr}`;

  if (decimals === 0) {
    return sym ? `${intStr} ${sym}` : intStr;
  }

  let fracStr = fracPart.toString().padStart(decimals, "0");
  if (fracStr.length > maxFractionDigits) fracStr = fracStr.slice(0, maxFractionDigits);
  fracStr = fracStr.replace(/0+$/, "");

  const numStr = fracStr ? `${intStr}.${fracStr}` : intStr;
  return sym ? `${numStr} ${sym}` : numStr;
}

function formatThousands(intStr: string): string {
  const negative = intStr.startsWith("-");
  const digits = negative ? intStr.slice(1) : intStr;
  const withSep = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative ? `-${withSep}` : withSep;
}

/**
 * Inverse of `formatToken`. Parses human-typed input ("1,234.56") into raw
 * base units using the token's decimals.
 *
 * Returns null on invalid input (multiple decimals, letters, negative,
 * empty). When decimals is null/undefined, the input is treated as already
 * in base units (integer only). Strips commas and surrounding whitespace.
 */
export function parseHumanToken(
  input: string,
  decimals: number | null | undefined,
): bigint | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim().replace(/,/g, "");
  if (trimmed === "" || trimmed === ".") return null;
  if (trimmed.startsWith("-")) return null;

  if (decimals === null || decimals === undefined) {
    if (!/^\d+$/.test(trimmed)) return null;
    try {
      return BigInt(trimmed);
    } catch {
      return null;
    }
  }

  if (!/^\d*\.?\d*$/.test(trimmed)) return null;
  const [intPart = "", fracPartRaw = ""] = trimmed.split(".");
  if (intPart === "" && fracPartRaw === "") return null;

  // Truncate (don't round) excess fractional precision so users can't
  // accidentally type a sub-base-unit amount and have it silently rounded up.
  const fracPart = fracPartRaw.slice(0, decimals).padEnd(decimals, "0");
  try {
    const intBig = intPart === "" ? 0n : BigInt(intPart);
    const fracBig = fracPart === "" ? 0n : BigInt(fracPart);
    return intBig * 10n ** BigInt(decimals) + fracBig;
  } catch {
    return null;
  }
}
