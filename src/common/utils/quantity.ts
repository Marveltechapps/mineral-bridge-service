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

/** The unit a catalog price is quoted in. Unknown text returns null so it is not treated as grams. */
export function commercialUnit(raw: unknown): QuantityUnit | null {
  const unit = String(raw ?? '').trim().toLowerCase();
  if (unit === 'ct' || unit === 'carat' || unit === 'carats') return 'ct';
  if (unit === 'g' || unit === 'gram' || unit === 'grams') return 'g';
  if (unit === 'kg' || unit === 'kilogram' || unit === 'kilograms') return 'kg';
  if (unit === 'oz' || unit === 'ounce' || unit === 'ounces' || unit === 'ozt' || unit === 'troy oz' || unit === 'troy ounce') return 'oz';
  if (unit === 'mt' || unit === 't' || unit === 'tonne' || unit === 'tonnes' || unit === 'ton') return 'MT';
  return null;
}

export function gramsInUnit(unit: string): number {
  const parsed = commercialUnit(unit);
  return parsed ? GRAMS_PER_UNIT[parsed] : 0;
}

export function toGrams(value: number, unit: QuantityUnit): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new AppError({
      status: 422,
      code: 'validation/failed',
      message: 'Quantity must be positive',
      fields: { quantity: 'Must be greater than zero' },
    });
  }
  const grams = Math.round(value * GRAMS_PER_UNIT[unit] * 1_000_000) / 1_000_000;
  if (grams <= 0) {
    throw new AppError({
      status: 422,
      code: 'validation/failed',
      message: 'Quantity must be positive',
      fields: { quantity: 'Must be greater than zero' },
    });
  }
  return grams;
}

/**
 * Read a persisted sell quantity back as the number the seller typed.
 * `{ value: 1000, unit: 'kg', grams: 1000 }` is 1 kg (grams were stored in `value`).
 * `{ value: 0, unit: 'kg', grams: 1000 }` is 1 kg (missing entered value, not a real zero).
 */
export function resolveEnteredQuantity(q?: {
  value?: unknown;
  unit?: string;
  grams?: number;
  base?: number;
} | null): { value: number; unit: string; grams?: number } {
  const rawUnit = String(q?.unit || 'kg');
  const unit = rawUnit === 'MT' ? 't' : rawUnit;
  const parsed = commercialUnit(unit);
  const per = parsed ? GRAMS_PER_UNIT[parsed] : 0;
  const grams = Number(q?.grams ?? q?.base ?? 0);
  let value = q?.value != null && q.value !== '' ? Number(q.value) : NaN;
  const storedAsGrams = Number.isFinite(value) && grams > 0 && per > 1 && Math.abs(value - grams) < 1e-6;
  if ((!Number.isFinite(value) || value === 0 || storedAsGrams) && grams > 0 && parsed && per > 0) {
    value = fromGrams(grams, parsed);
  }
  if (!Number.isFinite(value)) value = 0;
  return { value, unit, grams: grams || undefined };
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
