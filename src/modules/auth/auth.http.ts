import type { Request } from 'express';
import type { DeviceInfo } from '../sessions/session.types.js';

export function clientIp(req: Request): string | undefined {
  // Relies on `app.set('trust proxy', …)` being configured by the app builder.
  return req.ip ?? req.socket.remoteAddress ?? undefined;
}

/** "Chrome on macOS" — good enough for a session list; not used for any security decision. */
export function describeUserAgent(ua: string | undefined | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad|iOS/.test(ua)
        ? 'iOS'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Unknown OS';
  return `${browser} on ${os}`;
}

/** Merges the body's `device` with the contract headers (`X-Device-Id`, `X-Platform`). */
export function deviceFromRequest(
  req: Request,
  body?: { id?: string; platform?: string; name?: string; pushToken?: string },
): DeviceInfo {
  return {
    id: body?.id ?? req.header('x-device-id') ?? undefined,
    platform: body?.platform ?? req.header('x-platform') ?? undefined,
    name: body?.name,
    pushToken: body?.pushToken,
    userAgent: req.header('user-agent')?.slice(0, 512),
    ip: clientIp(req),
  };
}

export function noStore(res: import('express').Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}
