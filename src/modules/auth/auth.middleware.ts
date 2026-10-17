import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError, conflict, forbidden, unauthorized, unprocessable } from '../../common/errors/app-error.js';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { loadEnv } from '../../config/env.js';
import {
  evaluateStaffSession,
  findActiveCustomerSession,
  findStaffSessionByToken,
  revokeStaffSession,
  touchCustomerSession,
  touchStaffSession,
  verifyCsrfToken,
} from '../sessions/session.service.js';
import type { CustomerSessionRecord, StaffSessionRecord } from '../sessions/session.types.js';
import { accessSatisfies, findStaffById } from '../staff/staff.service.js';
import type { AccessLevel, PermissionModule, StaffRecord } from '../staff/staff.types.js';
import { userRepository } from '../users/user.repository.js';
import { hasRole, isPinSet, toWebKycStatus, verifyPin } from '../users/user.service.js';
import type { KycStatus, UserRecord, UserRole } from '../users/user.types.js';
import { readCookie } from './auth.cookies.js';
import { verifyAccessToken } from './auth.tokens.js';

// =============================================================================================
// Request context (WeakMaps avoid widening Express' Request type further)
// =============================================================================================

export interface UserContext {
  user: UserRecord;
  session: CustomerSessionRecord;
}
export interface StaffContext {
  staff: StaffRecord;
  session: StaffSessionRecord;
  /** The raw cookie value — needed to re-derive the CSRF token for `GET /me`. */
  sessionToken: string;
}

const userContexts = new WeakMap<Request, UserContext>();
const staffContexts = new WeakMap<Request, StaffContext>();

export function getUserContext(req: Request): UserContext {
  const ctx = userContexts.get(req);
  if (!ctx) throw unauthorized('auth/token-invalid', 'Authentication required');
  return ctx;
}

export function getStaffContext(req: Request): StaffContext {
  const ctx = staffContexts.get(req);
  if (!ctx) throw unauthorized('auth/session-expired', 'Your session has expired');
  return ctx;
}

// =============================================================================================
// Customer (mobile + web) — bearer access token
// =============================================================================================

/** Reads `X-Client` only; deliberately ignores request-context's "default to web" fallback. */
export function explicitClientFromHeaders(req: Request): 'mobile' | 'web' | null {
  const xClient = (req.header('x-client') ?? '').toLowerCase();
  if (xClient.startsWith('mineralbridge-mobile')) return 'mobile';
  if (xClient.startsWith('mineralbridge-web')) return 'web';
  const platform = (req.header('x-platform') ?? '').toLowerCase();
  if (platform === 'android' || platform === 'ios') return 'mobile';
  return null;
}

export function customerAuthError(
  client: 'mobile' | 'web' | 'admin' | 'unknown',
  kind: 'missing' | 'expired' | 'invalid',
): AppError {
  if (client === 'mobile') {
    return kind === 'expired'
      ? unauthorized('auth/token-expired', 'Your access token has expired.')
      : unauthorized('auth/token-invalid', 'Your session is not valid. Sign in again.');
  }
  // Web contract: every authorised endpoint answers 401 `auth/session-expired`.
  return unauthorized('auth/session-expired', 'Your session has expired. Sign in again.');
}

function bearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1]! : null;
}

async function authenticateUser(req: Request, token: string): Promise<void> {
  const verified = verifyAccessToken(token);
  if (!verified.ok) throw customerAuthError(req.apiClient, verified.reason);
  const { claims } = verified;

  // The `cli` claim is authoritative: a mobile token presented by a web client (or vice-versa) is refused.
  const headerClient = explicitClientFromHeaders(req);
  if (headerClient && headerClient !== claims.cli) {
    throw forbidden('auth/client-mismatch', 'This token was issued to a different client.');
  }
  req.apiClient = claims.cli;

  const session = await findActiveCustomerSession(claims.sid);
  if (!session || session.userId.toString() !== claims.sub || session.client !== claims.cli) {
    throw customerAuthError(claims.cli, 'invalid');
  }
  const user = await userRepository.findById(claims.sub);
  if (!user) throw customerAuthError(claims.cli, 'invalid');

  userContexts.set(req, { user, session });
  req.actor = {
    kind: 'user',
    userId: user.id,
    roles: user.roles,
    kycStatus: user.kycStatus,
    tier: user.tier,
    sessionId: session.publicId,
    client: claims.cli,
  };
  void touchCustomerSession(session.publicId).catch(() => undefined);
}

/** 401 when there is no valid access token. */
export const requireUser: RequestHandler = asyncHandler(async (req) => {
  const token = bearerToken(req);
  if (!token) throw customerAuthError(req.apiClient, 'missing');
  await authenticateUser(req, token);
});

/**
 * Guest-readable routes: no header ⇒ continue as a guest; a header that is present must be
 * valid (an expired token must produce a 401 so the client refreshes instead of silently
 * downgrading to guest data).
 */
export const optionalUser: RequestHandler = asyncHandler(async (req) => {
  const token = bearerToken(req);
  if (!token) return;
  await authenticateUser(req, token);
});

function userActor(req: Request) {
  if (req.actor?.kind !== 'user') throw customerAuthError(req.apiClient, 'missing');
  return req.actor;
}

/**
 * Gate error for unverified accounts. Same condition, two vocabularies (W-4):
 *   mobile → `403 kyc/not-verified`  { kycStatus: none | pending | rejected }
 *   web    → `403 kyc/not-approved`  { kycStatus: unverified | pending | rejected }
 */
export function kycGateError(client: 'mobile' | 'web' | 'admin' | 'unknown', status: KycStatus): AppError {
  if (client === 'mobile') {
    return forbidden('kyc/not-verified', 'Identity check required before trading.', { kycStatus: status });
  }
  return forbidden('kyc/not-approved', 'Your identity verification must be approved before you can do this.', {
    kycStatus: toWebKycStatus(status),
  });
}

/** `pending` is **not** sufficient — only `verified` passes. Must run after `requireUser`. */
export const requireKyc: RequestHandler = (req, _res, next) => {
  try {
    const actor = userActor(req);
    if (actor.kycStatus !== 'verified') {
      throw kycGateError(actor.client, actor.kycStatus as KycStatus);
    }
    next();
  } catch (err) {
    next(err);
  }
};

/** e.g. `requireRole('bank_operator')`. `both` satisfies `buyer` and `seller`. */
export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    try {
      const actor = userActor(req);
      if (!roles.some((r) => hasRole(actor.roles, r))) {
        throw forbidden('auth/role-required', 'Your account does not have the role required for this action.', {
          details: { required: roles },
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * `X-Transaction-Pin` check for bids, withdrawals and account deletion (mobile §3.6).
 * Failures: 409 `auth/pin-not-set`, 422 `auth/pin-invalid`, 423 `auth/pin-locked`.
 */
export const requireTransactionPin: RequestHandler = asyncHandler(async (req) => {
  const actor = userActor(req);
  const pin = req.header('x-transaction-pin');
  if (!pin) {
    if (!(await isPinSet(actor.userId))) {
      throw conflict('auth/pin-not-set', 'Set a transaction PIN before continuing.');
    }
    throw unprocessable('Enter your transaction PIN.', { pin: 'Required' }, 'auth/pin-invalid');
  }
  await verifyPin(actor.userId, pin);
});

/**
 * Web cookie-authenticated mutations (`/auth/refresh`, `/auth/logout`) — open question W-2.
 *
 * The cookie is `SameSite=Strict`; this is the second layer the web contract lacks:
 *   1. a browser-supplied `Origin` must be on the web allowlist (`CORS_WEB_ORIGINS`)
 *   2. `Sec-Fetch-Site: cross-site` is refused when no Origin is present
 *   3. optionally (`WEB_CSRF_REQUIRE_CUSTOM_HEADER=true`) a custom header that cross-site forms
 *      cannot send: `X-Requested-With: mb-web` or `X-Client: mineralbridge-web/…`
 * (3) is off by default until the web client sends one (W-5); turn it on in production.
 */
export const requireWebCookieOrigin: RequestHandler = (req, _res, next) => {
  const env = loadEnv();
  const csrf = () => forbidden('auth/csrf', 'Request origin not allowed.');
  const origin = req.header('origin');
  const allowed = new Set(env.corsWebOrigins);

  if (origin) {
    const ok = allowed.size > 0 ? allowed.has(origin) : env.NODE_ENV !== 'production';
    if (!ok) return next(csrf());
  } else if ((req.header('sec-fetch-site') ?? '').toLowerCase() === 'cross-site') {
    return next(csrf());
  }

  if (process.env.WEB_CSRF_REQUIRE_CUSTOM_HEADER === 'true' || env.NODE_ENV === 'production') {
    const marker = (req.header('x-requested-with') ?? '').toLowerCase() === 'mb-web';
    const webClient = (req.header('x-client') ?? '').toLowerCase().startsWith('mineralbridge-web');
    if (!marker && !webClient) return next(csrf());
  }
  next();
};

// =============================================================================================
// Staff (admin console) — opaque session cookie + CSRF
// =============================================================================================

async function loadStaffContext(req: Request): Promise<StaffContext | null> {
  const env = loadEnv();
  const token = readCookie(req, env.ADMIN_SESSION_COOKIE_NAME);
  if (!token) return null;
  const session = await findStaffSessionByToken(token);
  if (!session) return null;

  const now = new Date();
  const status = evaluateStaffSession(session, now);
  if (status !== 'ok') {
    if (status === 'idle_expired' || status === 'absolute_expired') {
      await revokeStaffSession(session.id, status, now);
    }
    return null;
  }
  const staff = await findStaffById(session.staffId.toString());
  if (!staff || staff.disabled) {
    await revokeStaffSession(session.id, 'staff_unavailable', now);
    return null;
  }
  void touchStaffSession(session.id, now).catch(() => undefined);
  return { staff, session, sessionToken: token };
}

function bindStaff(req: Request, ctx: StaffContext): void {
  staffContexts.set(req, ctx);
  req.apiClient = 'admin';
  req.actor = {
    kind: 'staff',
    staffId: ctx.staff.id,
    role: ctx.staff.role.name,
    permissions: ctx.staff.permissions,
    sessionId: ctx.session.publicId,
    sessionState: ctx.session.state,
    csrfTokenHash: ctx.session.csrfTokenHash,
  };
}

/**
 * Loads the admin session from `mb_admin_session`. A *locked* session still passes (so #10 unlock,
 * #11 sign-out and #12 /me work); everything else must add `requireUnlockedConsole` — or
 * `requireStaffPermission`, which includes it.
 */
export const requireStaff: RequestHandler = asyncHandler(async (req) => {
  const ctx = await loadStaffContext(req);
  if (!ctx) throw unauthorized('auth/session-expired', 'Your session has expired. Sign in again.');
  bindStaff(req, ctx);
});

/** For endpoints that accept either a session or an email body (e.g. password reset). */
export const optionalStaff: RequestHandler = asyncHandler(async (req) => {
  const ctx = await loadStaffContext(req);
  if (ctx) bindStaff(req, ctx);
});

function staffActor(req: Request) {
  if (req.actor?.kind !== 'staff') {
    throw unauthorized('auth/session-expired', 'Your session has expired. Sign in again.');
  }
  return req.actor;
}

/** `401 auth/console-locked` while the session is in the `locked` state. */
export const requireUnlockedConsole: RequestHandler = (req, _res, next) => {
  try {
    if (staffActor(req).sessionState === 'locked') {
      throw unauthorized('auth/console-locked', 'The console is locked. Enter your password to continue.');
    }
    next();
  } catch (err) {
    next(err);
  }
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Double-submit CSRF for every `POST/PUT/PATCH/DELETE` (admin §2). Missing/invalid ⇒ `403 auth/csrf`. */
export const requireCsrf: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  try {
    if (SAFE_METHODS.has(req.method)) return next();
    const actor = staffActor(req);
    const presented = req.header('x-csrf-token') ?? '';
    if (!verifyCsrfToken({ csrfTokenHash: actor.csrfTokenHash }, presented)) {
      throw forbidden('auth/csrf', 'Missing or invalid CSRF token.');
    }
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Module permission gate (admin §8): `edit` satisfies `view`. Implies an unlocked console.
 * Chain after `requireStaff` (and `requireCsrf` on mutations).
 */
export function requireStaffPermission(module: PermissionModule, level: 'view' | 'edit'): RequestHandler {
  return (req, _res, next) => {
    try {
      const actor = staffActor(req);
      if (actor.sessionState === 'locked') {
        throw unauthorized('auth/console-locked', 'The console is locked. Enter your password to continue.');
      }
      const have = actor.permissions[module] as AccessLevel | undefined;
      if (!accessSatisfies(have, level)) {
        throw forbidden('auth/forbidden', 'Your role does not permit this action.', {
          details: { module, required: level },
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
