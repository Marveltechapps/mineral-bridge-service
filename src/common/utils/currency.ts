import { AppError } from '../errors/app-error.js';
import type { CustomerMoney, StoredMoney } from './money.js';
import { toCustomerMoney } from './money.js';

/** Currency exponent table (ARCHITECTURE §6.2). The only place scale is decided. */
export const CURRENCY_EXPONENT: Record<string, number> = {
  USD: 2,
  KES: 2,
  NGN: 2,
  EUR: 2,
  GBP: 2,
  BTC: 8,
};

export const DEFAULT_CURRENCY = 'USD';

export function exponentOf(currency: string): number {
  const e = CURRENCY_EXPONENT[currency];
  if (e === undefined) {
    throw new AppError({
      status: 422,
      code: 'validation/failed',
      message: `Unsupported currency ${currency}`,
      fields: { currency: 'Unsupported currency' },
    });
  }
  return e;
}

export function money(amountMinor: number, currency = DEFAULT_CURRENCY): StoredMoney {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new Error('Money amountMinor must be a safe integer');
  }
  return { amountMinor, currency, scale: exponentOf(currency) };
}

/** Minimal persisted representation (scale is derived, never stored). */
export type MoneyDoc = { amountMinor: number; currency: string };

export function toStoredMoney(doc: MoneyDoc | null | undefined, fallbackCurrency = DEFAULT_CURRENCY): StoredMoney {
  const cur = doc?.currency ?? fallbackCurrency;
  return { amountMinor: doc?.amountMinor ?? 0, currency: cur, scale: exponentOf(cur) };
}

function groupDigits(n: string): string {
  return n.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Server-generated `display` string for mobile (never parsed back). */
export function displayMoney(m: MoneyDoc, compact = false): string {
  const exp = exponentOf(m.currency);
  const major = m.amountMinor / 10 ** exp;
  const symbol = m.currency === 'USD' ? '$' : m.currency === 'EUR' ? '€' : m.currency === 'GBP' ? '£' : `${m.currency} `;
  if (compact && major >= 1_000_000) return `${symbol}${(major / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (compact && major >= 10_000) return `${symbol}${(major / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  const whole = Math.floor(major);
  const frac = exp > 0 ? Math.round((major - whole) * 10 ** exp) : 0;
  const body = groupDigits(String(whole)) + (frac > 0 ? `.${String(frac).padStart(exp, '0')}` : '');
  return `${symbol}${body}`;
}

/** Mobile wire: { amount, currency, scale, display? } */
export function mobileMoney(doc: MoneyDoc | null | undefined, opts: { display?: boolean; compact?: boolean } = {}): CustomerMoney {
  const stored = toStoredMoney(doc);
  const out = toCustomerMoney(stored, true);
  if (opts.display !== false) out.display = displayMoney(stored, opts.compact);
  return out;
}

/** Web wire: { amount, currency } (minor units; scale implied by ISO 4217 exponent). */
export function webMoney(doc: MoneyDoc | null | undefined): CustomerMoney {
  return toCustomerMoney(toStoredMoney(doc), false);
}

/** Parse inbound customer money; enforces integer minor units and (mobile) scale == exponent. */
export function parseCustomerMoney(
  input: { amount: number; currency?: string; scale?: number },
  defaultCurrency = DEFAULT_CURRENCY,
): MoneyDoc {
  const currency = input.currency ?? defaultCurrency;
  const exp = exponentOf(currency);
  if (!Number.isSafeInteger(input.amount)) {
    throw new AppError({
      status: 422,
      code: 'validation/failed',
      message: 'Amount must be an integer in minor units',
      fields: { amount: 'Must be an integer number of minor units' },
    });
  }
  if (input.scale !== undefined && input.scale !== exp) {
    throw new AppError({
      status: 422,
      code: 'validation/failed',
      message: `Scale for ${currency} must be ${exp}`,
      fields: { scale: `Must equal ${exp}` },
    });
  }
  return { amountMinor: input.amount, currency };
}
