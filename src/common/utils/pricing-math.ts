import { percentOfMinor } from './money.js';
import { gramsInUnit } from './quantity.js';

/**
 * Unit prices are stored as integer "minor units x 10^4 per gram" (E4) so a price such as
 * $63.805/g is representable (6380.5 minor/g => 63_805_000 E4). Totals are computed once, in the
 * service, with half-up rounding.
 */
export const E4 = 10_000n;

export function totalMinor(grams: number, unitPriceMinorE4PerGram: number): number {
  const out = Math.round((grams * unitPriceMinorE4PerGram) / Number(E4));
  if (!Number.isSafeInteger(out)) throw new Error('Computed total exceeds safe integer range');
  return out;
}

/** Sheet price is major currency units per quoted unit. Storage is minor-units × 10^4 per gram. */
export function quotedPriceToE4PerGram(priceMajor: number, unit: string): number {
  const grams = gramsInUnit(unit);
  if (!grams || priceMajor < 0 || !Number.isFinite(priceMajor)) return 0;
  return Math.round((priceMajor * 100 * 10_000) / grams);
}

export function unitPriceMinorPerGram(unitPriceMinorE4PerGram: number): number {
  return Math.round(unitPriceMinorE4PerGram / Number(E4));
}

export function feeMinor(amountMinor: number, basisPoints: number): number {
  return percentOfMinor(amountMinor, basisPoints);
}

/** Fee schedule (basis points). Per-client configuration per X-6. */
export const FEES = {
  webBuyPlatformBps: 100, // 1%
  webSellPlatformBps: 200, // 2%
  mobileCartHandlingBps: 180, // 1.8%
  surcharge: { escrow: 0, wire: 0, lc: 50, btc: 100 } as Record<string, number>,
} as const;
