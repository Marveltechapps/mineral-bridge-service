/**
 * BUG-012: 1 kg must round-trip as 1 kg (not 1000 kg).
 * @tags bugfix selling
 */
import { describe, expect, it } from 'vitest';
import { fromGrams, mobileQuantity, resolveEnteredQuantity, toGrams } from '../../src/common/utils/quantity.js';

describe('bugfix quantity conversion (BUG-012)', () => {
  it.each([
    [1, 'kg' as const],
    [0.5, 'kg' as const],
    [1000, 'kg' as const],
    [1, 't' as const],
    [0.001, 'kg' as const],
  ])('bug_012_round_trip: (%s, %s) read-back matches', (value, unit) => {
    const grams = toGrams(value, unit);
    const back = fromGrams(grams, unit);
    expect(back).toBeCloseTo(value, 6);
    // API-style normalize: never treat grams as the entered unit value.
    expect(mobileQuantity(grams, unit === 't' ? 't' : unit === 'kg' ? 'kg' : 'g')).toMatchObject({
      value: expect.any(Number),
      unit: expect.stringMatching(/^(g|kg|t)$/),
      grams,
    });
    if (unit === 'kg' && value === 1) {
      expect(grams).toBe(1000);
      expect(fromGrams(grams, 'kg')).toBe(1);
      expect(mobileQuantity(grams, 'kg')).toEqual({ value: 1, unit: 'kg', grams: 1000 });
    }
  });

  it('bug_012_save_twice_no_compounding: converting 1 kg twice stays 1000 g', () => {
    const once = toGrams(1, 'kg');
    // Mistaken second conversion would be toGrams(1000, 'kg') === 1_000_000.
    expect(once).toBe(1000);
    expect(toGrams(fromGrams(once, 'kg'), 'kg')).toBe(1000);
  });

  it('bug_012_zero_or_negative_rejected', () => {
    expect(() => toGrams(0, 'kg')).toThrow();
    expect(() => toGrams(-1, 'kg')).toThrow();
  });

  it('bug_012 neighbouring: 1000 g displays as 1 kg via mobileQuantity', () => {
    expect(mobileQuantity(1000)).toEqual({ value: 1, unit: 'kg', grams: 1000 });
  });

  it('bug_012_value_equals_grams_reads_back_as_1_kg', () => {
    expect(resolveEnteredQuantity({ value: 1000, unit: 'kg', grams: 1000 })).toMatchObject({ value: 1, unit: 'kg' });
  });

  it('bug_013_zero_value_with_grams_reads_back_as_1_kg', () => {
    expect(resolveEnteredQuantity({ value: 0, unit: 'kg', grams: 1000 })).toMatchObject({ value: 1, unit: 'kg' });
  });

  it('bug_012 neighbouring: a real 1000 kg is not divided', () => {
    expect(resolveEnteredQuantity({ value: 1000, unit: 'kg', grams: 1_000_000 })).toMatchObject({ value: 1000, unit: 'kg' });
  });
});
