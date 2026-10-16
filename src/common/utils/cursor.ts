import { clampLimit } from '../pagination/paginate.js';
import type { CursorPage, OffsetPage } from '../pagination/paginate.js';
import { badRequest } from '../errors/app-error.js';

/** Offset-backed opaque cursor (`eyJvIjoyMH0` = {"o":20}). */
export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

export function decodeCursor(cursor: unknown): number {
  if (cursor === undefined || cursor === null || cursor === '') return 0;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')) as { o?: unknown };
    const o = Number(parsed.o);
    if (!Number.isInteger(o) || o < 0) throw new Error('bad');
    return o;
  } catch {
    throw badRequest('validation/bad-cursor', 'Invalid cursor');
  }
}

export type CursorQuery = { limit?: unknown; cursor?: unknown };

export function cursorWindow(q: CursorQuery, fallback = 20) {
  return { limit: clampLimit(q.limit, fallback, 100), skip: decodeCursor(q.cursor) };
}

export function buildCursorPage<T>(
  rows: T[],
  total: number,
  win: { limit: number; skip: number },
  counts?: Record<string, number>,
): CursorPage<T> {
  const hasMore = win.skip + rows.length < total;
  return {
    data: rows,
    meta: {
      total,
      limit: win.limit,
      nextCursor: hasMore ? encodeCursor(win.skip + rows.length) : null,
      hasMore,
      ...(counts ? { counts } : {}),
    },
  };
}

export function pageWindow(q: { page?: unknown; perPage?: unknown }, fallbackPerPage = 20) {
  const page = Math.max(1, Math.floor(Number(q.page)) || 1);
  const perPage = clampLimit(q.perPage, fallbackPerPage, 100);
  return { page, perPage, skip: (page - 1) * perPage };
}

export function buildOffsetPage<T>(items: T[], total: number, win: { page: number; perPage: number }): OffsetPage<T> {
  return { items, page: win.page, perPage: win.perPage, total };
}
