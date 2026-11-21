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

/** Doc 07 AUTH-03/05: web refresh cookie scoped to `/v2/auth`. */
export const V2_WEB_REFRESH_COOKIE_PATH = '/v2/auth';

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

export function v2WebRefreshCookieOptions(persistent = true): CookieOptions {
  const options: CookieOptions = {
    httpOnly: true,
    secure: secure(),
    sameSite: 'strict',
    path: V2_WEB_REFRESH_COOKIE_PATH,
  };
  if (persistent) options.maxAge = loadEnv().WEB_REFRESH_TTL_SECONDS * 1000;
  return options;
}

export function setV2WebRefreshCookie(res: Response, refreshToken: string, persistent = true): void {
  res.cookie(loadEnv().WEB_REFRESH_COOKIE_NAME, refreshToken, v2WebRefreshCookieOptions(persistent));
}

export function clearV2WebRefreshCookie(res: Response): void {
  const { maxAge: _maxAge, ...opts } = v2WebRefreshCookieOptions();
  void _maxAge;
  res.clearCookie(loadEnv().WEB_REFRESH_COOKIE_NAME, opts);
}

/**
 * `/admin/v1` keeps Path=/admin. `/v2/admin` must use Path=/v2/admin, otherwise the browser
 * stores the session and then never sends it on the v2 surface.
 */
export function adminSessionCookiePath(req?: { originalUrl?: string }): string {
  const url = req?.originalUrl ?? '';
  if (url.startsWith('/v2/admin')) return '/v2/admin';
  return ADMIN_SESSION_COOKIE_PATH;
}

export function adminSessionCookieOptions(path = ADMIN_SESSION_COOKIE_PATH): CookieOptions {
  return {
    httpOnly: true,
    secure: secure(),
    sameSite: 'strict',
    path,
    // Session cookie lifetime is enforced server-side (idle + absolute); the browser cookie
    // is bounded by the absolute TTL so it cannot outlive the session by much.
    maxAge: loadEnv().ADMIN_ABSOLUTE_TTL_SECONDS * 1000,
  };
}

export function setAdminSessionCookie(res: Response, sessionToken: string, req?: { originalUrl?: string }): void {
  res.cookie(loadEnv().ADMIN_SESSION_COOKIE_NAME, sessionToken, adminSessionCookieOptions(adminSessionCookiePath(req)));
}

export function clearAdminSessionCookie(res: Response, req?: { originalUrl?: string }): void {
  const { maxAge: _maxAge, ...opts } = adminSessionCookieOptions(adminSessionCookiePath(req));
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
