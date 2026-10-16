import { percentOfMinor } from './money.js';

/**
 * Unit prices are stored as integer "minor units x 10^4 per gram" (E4) so a price such as
 * $63.805/g is representable (6380.5 minor/g => 63_805_000 E4). Totals are computed once, in the
 * service, with half-up rounding.
 */
export const E4 = 10_000n;

export function totalMinor(grams: number, unitPriceMinorE4PerGram: number): number {
  const num = BigInt(Math.round(grams)) * BigInt(Math.round(unitPriceMinorE4PerGram));
  const q = (num + E4 / 2n) / E4;
  const out = Number(q);
  if (!Number.isSafeInteger(out)) throw new Error('Computed total exceeds safe integer range');
  return out;
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
