import type { StoredMoney } from '../../../common/utils/money.js';
import { Rate } from '../../../models/trading.models.js';
import { priceTimesQuantity, type StoredUnitPrice } from '../shared/money.js';

export type RateDoc = { rateId: string; mineral: string; grade: string; buy: StoredUnitPrice; sell: StoredUnitPrice };

export const rateKey = (mineral: string, grade?: string | null) => `${mineral}|${grade ?? ''}`.toLowerCase();

export async function loadRateIndex(): Promise<Map<string, RateDoc>> {
  const rates = (await Rate.find().lean()) as unknown as RateDoc[];
  const idx = new Map<string, RateDoc>();
  for (const r of rates) {
    idx.set(rateKey(r.mineral, r.grade), r);
    if (!idx.has(rateKey(r.mineral))) idx.set(rateKey(r.mineral), r);
  }
  return idx;
}

export function lookupRate(idx: Map<string, RateDoc>, mineral: string, grade?: string | null): RateDoc | undefined {
  return idx.get(rateKey(mineral, grade)) ?? idx.get(rateKey(mineral));
}

/** Realisable value = quantity × live SELL rate; falls back to cost basis when no rate exists. */
export function realisableOf(
  lot: Record<string, any>,  
  idx: Map<string, RateDoc>,
): { realisable: StoredMoney | undefined; rate: RateDoc | undefined } {
  const rate = lookupRate(idx, lot.mineral?.name ?? '', lot.grade);
  if (!rate) return { realisable: lot.costBasis, rate: undefined };
  return { realisable: priceTimesQuantity(rate.sell, lot.quantity), rate };
}
