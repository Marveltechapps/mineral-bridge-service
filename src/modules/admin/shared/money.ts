import { z } from 'zod';
import {
  fromAdminMajor,
  toAdminMoney,
  type AdminMoney,
  type StoredMoney,
} from '../../../common/utils/money.js';
import { unprocessable } from '../../../common/errors/app-error.js';

/**
 * Admin wire money = decimal MAJOR units. Persistence = integer minor units (StoredMoney).
 * All conversion goes through common/utils/money.ts (fromAdminMajor / toAdminMoney).
 */
export const CURRENCIES = ['USD', 'KES', 'BTC'] as const;
export type Currency = (typeof CURRENCIES)[number];
export const CURRENCY_SCALE: Record<Currency, number> = { USD: 2, KES: 2, BTC: 8 };

export const QUANTITY_UNITS = ['kg', 't', 'g', 'oz'] as const;
export type QuantityUnit = (typeof QUANTITY_UNITS)[number];

const GRAMS: Record<QuantityUnit, number> = { g: 1, kg: 1000, t: 1_000_000, oz: 31.1034768 };

export type AdminQuantity = { value: number; unit: QuantityUnit };
export type AdminUnitPrice = AdminMoney & { per: QuantityUnit };
export type StoredUnitPrice = StoredMoney & { per: QuantityUnit };

export function scaleFor(currency: string): number {
  return CURRENCY_SCALE[currency as Currency] ?? 2;
}

function decimals(n: number): number {
  const s = String(n);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  const i = s.indexOf('.');
  return i === -1 ? 0 : s.length - i - 1;
}

export const adminMoneySchema = z.object({
  amount: z.number().finite(),
  currency: z.enum(CURRENCIES),
});

export const adminUnitPriceSchema = adminMoneySchema.extend({ per: z.enum(QUANTITY_UNITS) });
export const adminQuantitySchema = z.object({
  value: z.number().finite().positive(),
  unit: z.enum(QUANTITY_UNITS),
});

/** Admin wire → stored. Rejects more decimals than the currency allows (never rounds money silently). */
export function parseMoney(input: { amount: number; currency: string }, field = 'amount'): StoredMoney {
  const scale = scaleFor(input.currency);
  if (!Number.isFinite(input.amount)) throw unprocessable('Invalid amount', { [field]: 'Must be a number' });
  if (decimals(input.amount) > scale) {
    throw unprocessable('Too many decimal places', { [field]: `At most ${scale} decimals for ${input.currency}` });
  }
  return fromAdminMajor(input.amount, input.currency, scale);
}

export function parsePositiveMoney(input: { amount: number; currency: string }, field = 'amount'): StoredMoney {
  const m = parseMoney(input, field);
  if (m.amountMinor <= 0) throw unprocessable('Amount must be greater than 0', { [field]: 'Must be greater than 0' });
  return m;
}

export function parseUnitPrice(input: { amount: number; currency: string; per: QuantityUnit }, field = 'amount'): StoredUnitPrice {
  return { ...parseMoney(input, field), per: input.per };
}

export function outMoney(m?: StoredMoney | null): AdminMoney | null {
  if (!m || typeof m.amountMinor !== 'number') return null;
  return toAdminMoney(m);
}

export function outMoneyOrZero(m: StoredMoney | null | undefined, currency = 'USD'): AdminMoney {
  return outMoney(m) ?? { amount: 0, currency };
}

export function outUnitPrice(p?: StoredUnitPrice | null): AdminUnitPrice | null {
  if (!p || typeof p.amountMinor !== 'number') return null;
  return { ...toAdminMoney(p), per: p.per };
}

export function outQty(q?: { value: number; unit: string } | null): AdminQuantity | null {
  if (!q) return null;
  return { value: q.value, unit: q.unit as QuantityUnit };
}

export function convertQty(value: number, from: QuantityUnit, to: QuantityUnit): number {
  return (value * GRAMS[from]) / GRAMS[to];
}

/** price (per `price.per`) × quantity → stored total (integer minor units, half-up). */
export function priceTimesQuantity(price: StoredUnitPrice, qty: { value: number; unit: string }): StoredMoney {
  const inPer = convertQty(qty.value, qty.unit as QuantityUnit, price.per);
  return { amountMinor: Math.round(price.amountMinor * inPer), currency: price.currency, scale: price.scale };
}

export function addStored(a: StoredMoney | undefined, b: StoredMoney): StoredMoney {
  if (!a) return b;
  if (a.currency !== b.currency) throw new Error(`Currency mismatch ${a.currency}/${b.currency}`);
  return { ...a, amountMinor: a.amountMinor + b.amountMinor };
}

export function zeroStored(currency = 'USD'): StoredMoney {
  return { amountMinor: 0, currency, scale: scaleFor(currency) };
}

export function pctChange(from: number, to: number): number {
  if (!from) return 0;
  return Number((((to - from) / from) * 100).toFixed(1));
}

/** Human text for toasts: $5,940,000 / KES 1,000 */
export function formatMoneyText(m: AdminMoney | null): string {
  if (!m) return '—';
  const sym = m.currency === 'USD' ? '$' : `${m.currency} `;
  return `${sym}${m.amount.toLocaleString('en-US', { maximumFractionDigits: scaleFor(m.currency) })}`;
}

export const moneySub = {
  amountMinor: { type: Number, required: true },
  currency: { type: String, required: true, default: 'USD' },
  scale: { type: Number, required: true, default: 2 },
};
export const unitPriceSub = { ...moneySub, per: { type: String, enum: QUANTITY_UNITS, required: true, default: 'kg' } };
export const quantitySub = {
  value: { type: Number, required: true },
  unit: { type: String, enum: QUANTITY_UNITS, required: true, default: 'kg' },
};
export const refSub = {
  type: { type: String, required: true },
  id: { type: String, required: true },
  label: { type: String },
};
