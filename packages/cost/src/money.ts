/**
 * Integer money arithmetic for the Cost Engine.
 *
 * Every authoritative monetary value in Phase 16 is a whole number of minor
 * units — cents for USD, yen for JPY — and this module is the only place a
 * division touches one. Two rules hold without exception:
 *
 * 1. **Addition is exact.** Inputs are safe non-negative integers; a running
 *    sum is checked with `Number.isSafeInteger` after every combination, so
 *    an overflow refuses the derivation instead of silently losing precision.
 *
 * 2. **Division is exact.** `Math.floor(n / d)` in IEEE-754 can be off by one
 *    near the safe-integer boundary (a quotient just below an integer rounds
 *    up to it), so the division is done in `BigInt` and converted back only
 *    after both results are proven safe. The remainder is returned alongside
 *    the floored quotient, so no minor unit is dropped without being reported.
 *
 * There is no `toFixed`, no `parseFloat`, no percentage math and no binary
 * fraction anywhere in this file.
 */

/** A whole number of minor units: a safe integer, never negative. */
export function isMinorAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Add two minor-unit amounts. Returns `null` when the result would leave the
 * safe-integer range — the honest answer for a sum that cannot be represented
 * exactly, rather than a rounded one.
 */
export function addMinor(a: number, b: number): number | null {
  if (!isMinorAmount(a) || !isMinorAmount(b)) return null;
  const sum = a + b;
  return Number.isSafeInteger(sum) ? sum : null;
}

/**
 * Sum a list of minor-unit amounts exactly. Returns `null` on the first
 * invalid input or the first overflow, so one bad fact refuses the whole
 * aggregate instead of quietly shrinking it.
 */
export function sumMinor(values: readonly number[]): number | null {
  let total = 0;
  for (const value of values) {
    const next = addMinor(total, value);
    if (next === null) return null;
    total = next;
  }
  return total;
}

/**
 * Divide a minor-unit total by a count, exactly.
 *
 * Returns the floored quotient plus the remainder — together they reconstruct
 * the exact rational value, so a display can round while an audit can prove.
 * `null` when the numerator is not a minor amount or the denominator is not a
 * positive count: a zero denominator is "no data", never a division by zero
 * dressed up as zero cost.
 */
export function divideMinor(
  numeratorMinor: number,
  denominator: number,
): { averageMinor: number; remainderMinor: number } | null {
  if (!isMinorAmount(numeratorMinor)) return null;
  if (!Number.isSafeInteger(denominator) || denominator <= 0) return null;
  const numerator = BigInt(numeratorMinor);
  const divisor = BigInt(denominator);
  const average = numerator / divisor;
  const remainder = numerator % divisor;
  // Both are provably within range: average ≤ numerator and remainder <
  // divisor, and each input was a safe integer. The checks are stated anyway
  // so a future change to this function cannot widen a boundary unnoticed.
  if (average > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { averageMinor: Number(average), remainderMinor: Number(remainder) };
}
