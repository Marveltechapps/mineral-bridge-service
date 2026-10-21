import type { CookieOptions, Request, Response } from 'express';
import { loadEnv } from '../../config/env.js';

/**
 * Web refresh cookie.
 *
 * The web contract says `Path=/auth`, but the route is mounted at `/v1/auth/*`. A browser only
 * sends a cookie whose Path is a prefix of the request path, so `Path=/auth` would never be sent
 * to `/v1/auth/refresh` and every page reload would sign the user out (open question W-3,
 * ARCHITECTURE §9). We therefore issue `Path=/v1/auth` — **needs web-team sign-off**, but no
 * other value works with this mount. The name stays `mb_refresh`.
 */
export const WEB_REFRESH_COOKIE_PATH = '/v1/auth';

/**
 * Admin session cookie: `Path=/admin` covers `/admin/v1/*` and nothing on the customer API, so a
 * customer-facing request never carries it.
 */
export const ADMIN_SESSION_COOKIE_PATH = '/admin';

function secure(): boolean {
  const env = loadEnv();
  return env.COOKIE_SECURE || env.NODE_ENV === 'production';
}

export function webRefreshCookieOptions(persistent = true): CookieOptions {
  const options: CookieOptions = {
    httpOnly: true,
    secure: secure(),
    sameSite: 'strict',
    path: WEB_REFRESH_COOKIE_PATH,
  };
  // A session cookie (no Max-Age) is dropped when the browser session ends.
  // The refresh token's server-side expiry is unchanged.
  if (persistent) options.maxAge = loadEnv().WEB_REFRESH_TTL_SECONDS * 1000;
  return options;
}

export function setWebRefreshCookie(res: Response, refreshToken: string, persistent = true): void {
  res.cookie(loadEnv().WEB_REFRESH_COOKIE_NAME, refreshToken, webRefreshCookieOptions(persistent));
}

export function clearWebRefreshCookie(res: Response): void {
  const { maxAge: _maxAge, ...opts } = webRefreshCookieOptions();
  void _maxAge;
  res.clearCookie(loadEnv().WEB_REFRESH_COOKIE_NAME, opts);
}

export function adminSessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: secure(),
    sameSite: 'strict',
    path: ADMIN_SESSION_COOKIE_PATH,
    // Session cookie lifetime is enforced server-side (idle + absolute); the browser cookie
    // is bounded by the absolute TTL so it cannot outlive the session by much.
    maxAge: loadEnv().ADMIN_ABSOLUTE_TTL_SECONDS * 1000,
  };
}

export function setAdminSessionCookie(res: Response, sessionToken: string): void {
  res.cookie(loadEnv().ADMIN_SESSION_COOKIE_NAME, sessionToken, adminSessionCookieOptions());
}

export function clearAdminSessionCookie(res: Response): void {
  const { maxAge: _maxAge, ...opts } = adminSessionCookieOptions();
  void _maxAge;
  res.clearCookie(loadEnv().ADMIN_SESSION_COOKIE_NAME, opts);
}

/** Works with or without `cookie-parser` mounted. */
export function readCookie(req: Request, name: string): string | undefined {
  const parsed = (req as Request & { cookies?: Record<string, string> }).cookies?.[name];
  if (typeof parsed === 'string' && parsed.length > 0) return parsed;
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
