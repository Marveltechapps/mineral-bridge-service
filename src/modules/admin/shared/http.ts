import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Model } from 'mongoose';
import { badRequest } from '../../../common/errors/app-error.js';
import type { AdminPage } from '../../../common/pagination/paginate.js';
import { clampPage } from '../../../common/pagination/paginate.js';

export type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/** Express 4 does not catch async rejections — funnel them to the error handler. */
export const wrap =
  (fn: AsyncHandler): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export type ActionResult<T> = { data: T; message: string; auditId: string };

export function action<T>(data: T, message: string, auditId: string): ActionResult<T> {
  return { data, message, auditId };
}

/** Percentage change from rom to 	o (0 when rom is 0). */

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive contains on any of the fields. */
export function searchFilter(q: unknown, fields: string[]): Record<string, unknown> | null {
  if (typeof q !== 'string' || !q.trim()) return null;
  const re = new RegExp(escapeRegex(q.trim()), 'i');
  return { $or: fields.map((f) => ({ [f]: re })) };
}

export function and(...parts: unknown[]): Record<string, unknown> {
  const real = parts.filter(Boolean) as Record<string, unknown>[];
  if (real.length === 0) return {};
  if (real.length === 1) return real[0]!;
  return { $and: real };
}

export type Paging = { page: number; pageSize: number; skip: number };

export function paging(req: Request, defaultSize = 25): Paging {
  const page = clampPage(req.query.page, 1);
  const raw = Number(req.query.pageSize ?? defaultSize);
  const pageSize = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), 100) : defaultSize;
  return { page, pageSize, skip: (page - 1) * pageSize };
}

/** ?sort=<field>&order=asc|desc mapped through the endpoint's sortable-field whitelist. */
export function sortSpec(req: Request, map: Record<string, string>, fallback: Record<string, 1 | -1>): Record<string, 1 | -1> {
  const sort = req.query.sort;
  if (sort === undefined || sort === '') return fallback;
  if (typeof sort !== 'string' || !(sort in map)) {
    throw badRequest('request/malformed', `Unknown sort field "${String(sort)}". Allowed: ${Object.keys(map).join(', ')}`);
  }
  const dir: 1 | -1 = req.query.order === 'desc' ? -1 : 1;
  return { [map[sort]!]: dir, _id: 1 };
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw badRequest('request/malformed', `Invalid ${name}: ${String(value)}. Allowed: ${allowed.join(', ')}`);
  }
  return value as T;
}

export function boolQ(value: unknown): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw badRequest('request/malformed', `Expected a boolean, got "${String(value)}"`);
}

export function intQ(value: unknown, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw badRequest('request/malformed', `${name} must be an integer`);
  return n;
}

export function dateQ(value: unknown, name: string): Date | undefined {
  if (value === undefined || value === '') return undefined;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) throw badRequest('request/malformed', `${name} must be an ISO date`);
  return d;
}

export type PageOptions<D, R> = {
  filter: Record<string, unknown>;
  sort: Record<string, 1 | -1>;
  paging: Paging;
  /** Batch mapper so services can prefetch staff / users once per page. */
  map: (docs: D[]) => Promise<R[]> | R[];
  counts?: () => Promise<Record<string, number>>;
  /** Filter that defines "total unfiltered" (e.g. lots in custody). */
  totalUnfiltered?: Record<string, unknown>;
  extraMeta?: () => Promise<Record<string, unknown>>;
};

export async function pageOf<D, R>(model: Model<any>, opts: PageOptions<D, R>): Promise<AdminPage<R> & { meta: Record<string, unknown> }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const [docs, total] = await Promise.all([
    model.find(opts.filter).sort(opts.sort).skip(opts.paging.skip).limit(opts.paging.pageSize).lean<D[]>(),
    model.countDocuments(opts.filter),
  ]);
  const data = await opts.map(docs);
  const meta: Record<string, unknown> = { page: opts.paging.page, pageSize: opts.paging.pageSize, total };
  if (opts.totalUnfiltered) meta.totalUnfiltered = await model.countDocuments(opts.totalUnfiltered);
  if (opts.counts) meta.counts = await opts.counts();
  if (opts.extraMeta) Object.assign(meta, await opts.extraMeta());
  return { data, meta } as AdminPage<R> & { meta: Record<string, unknown> };
}

/** Wrap an in-memory list in the Page<T> envelope. */
export function pageOfArray<T>(all: T[], p: Paging, extra: Record<string, unknown> = {}): AdminPage<T> {
  return { data: all.slice(p.skip, p.skip + p.pageSize), meta: { page: p.page, pageSize: p.pageSize, total: all.length, ...extra } as AdminPage<T>['meta'] };
}

/* ── CSV ── */

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: Array<Array<unknown>>): string {
  return [columns, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function sendCsv(res: Response, filename: string, csv: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

export const isoDate = (d: Date | string | number = new Date()): string => new Date(d).toISOString().slice(0, 10);
export const iso = (d: Date | string | number | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

export function daysBetween(a: Date | string | number, b: Date | string | number = Date.now()): number {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
}

export function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}
