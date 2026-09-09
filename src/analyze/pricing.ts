/** USD arithmetic shared by analysis and budget projections. */
import type { Card } from "../types/index.js";

/**
 * Parse nonnegative decimal USD into cents before doing arithmetic. Extra decimal
 * places round half up; malformed, negative, and unsafe values remain missing.
 */
export function priceUsdCents(value: string | null | undefined): number | null {
  if (value == null || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [dollars = "0", fractional = ""] = value.split(".");
  const cents =
    Number(dollars) * 100 +
    Number(fractional.padEnd(2, "0").slice(0, 2)) +
    (Number(fractional[2] ?? "0") >= 5 ? 1 : 0);
  return Number.isSafeInteger(cents) ? cents : null;
}

export function defaultUsdCents(card: Card): number | null {
  return priceUsdCents(card.prices.usd);
}

/** Cheapest priced printing, falling back to the chosen price when none are priced. */
export function cheapestUsdCents(card: Card): number | null {
  let min: number | null = null;
  for (const printing of card.printings) {
    const cents = priceUsdCents(printing.prices.usd);
    if (cents !== null && (min === null || cents < min)) min = cents;
  }
  return min ?? defaultUsdCents(card);
}
