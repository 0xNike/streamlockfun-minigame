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
