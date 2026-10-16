import { AppError } from '../errors/app-error.js';

/** Quantity is persisted as integer grams. Troy ounce per ARCHITECTURE §6.5. */
export const GRAMS_PER_UNIT = {
  g: 1,
  kg: 1_000,
  t: 1_000_000,
  MT: 1_000_000,
  oz: 31.1034768,
  ct: 0.2,
} as const;

export type QuantityUnit = keyof typeof GRAMS_PER_UNIT;
export type MobileUnit = 'g' | 'kg' | 't';

export function toGrams(value: number, unit: QuantityUnit): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new AppError({
      status: 422,
      code: 'validation/failed',
      message: 'Quantity must be positive',
      fields: { quantity: 'Must be greater than zero' },
    });
  }
  return Math.round(value * GRAMS_PER_UNIT[unit]);
}

export function fromGrams(grams: number, unit: QuantityUnit): number {
  const raw = grams / GRAMS_PER_UNIT[unit];
  return Number(raw.toFixed(unit === 'oz' || unit === 'ct' ? 4 : 6));
}

export function mobileQuantity(grams: number, preferred?: MobileUnit) {
  const unit: MobileUnit = preferred ?? (grams >= 1_000_000 && grams % 1_000_000 === 0 ? 't' : grams >= 1_000 ? 'kg' : 'g');
  return { value: fromGrams(grams, unit), unit, grams };
}

export function webQuantity(grams: number, preferred?: QuantityUnit) {
  const unit: QuantityUnit = preferred ?? (grams >= 1_000_000 && grams % 1_000_000 === 0 ? 'MT' : grams >= 1_000 ? 'kg' : 'g');
  return { value: fromGrams(grams, unit), unit };
}
