import { badRequest } from '../../../common/errors/app-error.js';
import { MS_DAY } from '../shared/enums.js';

export type ReportWindow = '30d' | '90d' | '1y';

export function parseWindow(value: unknown, fallback: ReportWindow = '90d'): { key: ReportWindow; ms: number; from: Date; prevFrom: Date; now: Date } {
  const key = (value === undefined || value === '' ? fallback : value) as string;
  const days = key === '30d' ? 30 : key === '90d' ? 90 : key === '1y' ? 365 : null;
  if (days === null) throw badRequest('request/malformed', 'window must be one of 30d, 90d, 1y');
  const now = new Date();
  const ms = days * MS_DAY;
  return { key: key as ReportWindow, ms, now, from: new Date(now.getTime() - ms), prevFrom: new Date(now.getTime() - 2 * ms) };
}

/** Aggregation expression: USD minor units of a settlement (usdEquivalent, else the amount when already USD). */
export const USD_MINOR = {
  $ifNull: ['$usdEquivalent.amountMinor', { $cond: [{ $eq: ['$amount.currency', 'USD'] }, '$amount.amountMinor', 0] }],
};

export const usd = (minor: number) => ({ amount: Number((minor / 100).toFixed(2)), currency: 'USD' as const });

export function startOfWeekUtc(now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(d.getTime() - dow * MS_DAY);
}

export const round1 = (n: number) => Math.round(n * 10) / 10;
export const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
