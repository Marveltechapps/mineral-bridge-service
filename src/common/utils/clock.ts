/** Injectable clock so time-dependent rules (auctions, offers, quotes) are testable. */
let override: (() => Date) | null = null;

export function now(): Date {
  return override ? override() : new Date();
}

export function setClock(fn: (() => Date) | null): void {
  override = fn;
}

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
