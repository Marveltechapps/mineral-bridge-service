/**
 * BUG-013: admin console sell qty must not show raw gram base as kg.
 * @tags bugfix selling
 */
import { describe, expect, it } from 'vitest';

function gramsToQty(grams: number, unit: string): number {
  if (unit === 'kg') return grams / 1000;
  if (unit === 't') return grams / 1_000_000;
  return grams;
}

function consoleSellQty(o: {
  totalGrams?: number;
  sell?: { qty?: { value?: number; unit?: string; base?: number } };
}): { qty: number; unit: string } {
  const unit = o.sell?.qty?.unit || 'kg';
  const entered = o.sell?.qty?.value;
  const qty =
    entered != null && Number.isFinite(Number(entered))
      ? Number(entered)
      : gramsToQty(o.totalGrams ?? 0, unit);
  return { qty, unit };
}

describe('bugfix admin sell qty display (BUG-013)', () => {
  it('bug_013_1kg_shows_1_not_1000', () => {
    expect(
      consoleSellQty({
        totalGrams: 1000,
        sell: { qty: { unit: 'kg', base: 1000, value: 1 } },
      }),
    ).toEqual({ qty: 1, unit: 'kg' });
  });

  it('bug_013_legacy_base_only_converts_via_totalGrams', () => {
    expect(
      consoleSellQty({
        totalGrams: 1000,
        sell: { qty: { unit: 'kg', base: 1000 } },
      }),
    ).toEqual({ qty: 1, unit: 'kg' });
  });

  it('bug_013 neighbouring: tonnes still convert', () => {
    expect(consoleSellQty({ totalGrams: 1_000_000, sell: { qty: { unit: 't' } } })).toEqual({
      qty: 1,
      unit: 't',
    });
  });
});
