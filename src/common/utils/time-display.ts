const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WAT_OFFSET_MS = 3_600_000;

function wat(d: Date): Date {
  return new Date(d.getTime() + WAT_OFFSET_MS);
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** "9 Sep · 08:40" in WAT (UTC+1), as the mobile contract's desk-facing display. */
export function watDisplay(d: Date): string {
  const w = wat(d);
  return `${w.getUTCDate()} ${MONTHS[w.getUTCMonth()]} · ${p2(w.getUTCHours())}:${p2(w.getUTCMinutes())}`;
}

export function watWindowDisplay(from: Date, to: Date): string {
  const f = wat(from);
  const t = wat(to);
  return `Arriving ${DAYS[f.getUTCDay()]} ${f.getUTCDate()} ${MONTHS[f.getUTCMonth()]}, ${p2(f.getUTCHours())}:${p2(f.getUTCMinutes())}–${p2(t.getUTCHours())}:${p2(t.getUTCMinutes())}`;
}

export function countdownDisplay(closesAt: Date, nowDate: Date): string {
  const ms = closesAt.getTime() - nowDate.getTime();
  if (ms <= 0) return 'Ended';
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function agoDisplay(then: Date, nowDate: Date): string {
  const s = Math.max(0, Math.floor((nowDate.getTime() - then.getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

export function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}
