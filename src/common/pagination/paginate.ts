export type CursorPage<T> = {
  data: T[];
  meta: {
    total: number;
    limit: number;
    nextCursor: string | null;
    hasMore?: boolean;
    counts?: Record<string, number>;
  };
};

export type OffsetPage<T> = {
  items: T[];
  page: number;
  perPage: number;
  total: number;
};

export type AdminPage<T> = {
  data: T[];
  meta: {
    page: number;
    pageSize: number;
    total: number;
    totalUnfiltered?: number;
    counts?: Record<string, number>;
  };
};

export function clampLimit(value: unknown, fallback = 24, max = 100): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

export function clampPage(value: unknown, fallback = 1): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}
