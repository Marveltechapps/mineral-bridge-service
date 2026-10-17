import type { Request, Response } from 'express';
import { AppError, conflict, notFound } from '../../common/errors/app-error.js';
import { maskIp, normalizeEmail, normalizePhone } from '../../common/utils/phone.js';
import { loadEnv } from '../../config/env.js';
import { getWebKycStage } from '../kyc/kyc.service.js';
import {
  listActiveCustomerSessions,
  revokeAllCustomerSessions,
  revokeCustomerSession,
  revokeSessionByRefreshToken,
} from '../sessions/session.service.js';
import {
  hasRole,
  initialsOf,
  scheduleAccountDeletion,
  toWebKycStatus,
} from '../users/user.service.js';
import type { UserRecord } from '../users/user.types.js';
import { clearWebRefreshCookie, readCookie, setWebRefreshCookie } from './auth.cookies.js';
import { clientIp, describeUserAgent, deviceFromRequest, noStore } from './auth.http.js';
import { getUserContext } from './auth.middleware.js';
import {
  changeWebPassword,
  refreshCustomerTokens,
  registerWeb,
  requestWebOtp,
  resendWebOtp,
  verifyWebOtp,
  webMethodForChannel,
} from './auth.service.js';
import { verifyAccessToken } from './auth.tokens.js';
import type { ChallengeInfo } from './otp.service.js';
import type { WebOtpRequestBody, WebRegisterBody } from './web.auth.schemas.js';

const WEB_CODE_LENGTH = 4 as const;

function challengeBody(info: ChallengeInfo) {
  return {
    challengeId: info.challengeId,
    method: webMethodForChannel(info.channel),
    target: info.maskedDestination,
    expiresIn: info.expiresInSeconds,
    resendAfter: info.resendAfterSeconds,
    codeLength: WEB_CODE_LENGTH,
  };
}

/** `buyer | seller | both` — `bank_operator` is an additive capability, not a trading role. */
export function primaryTradeRole(roles: readonly string[]): 'buyer' | 'seller' | 'both' {
  if (hasRole(roles, 'buyer') && hasRole(roles, 'seller')) return 'both';
  if (roles.includes('seller')) return 'seller';
  return 'buyer';
}

function countryName(code: string | undefined): string {
  if (!code) return '';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function toWebUserProfile(user: UserRecord) {
  return {
    id: user.id,
    fullName: user.profile.fullName ?? '',
    email: user.email ?? '',
    mobile: user.phone ?? '',
    countryCode: user.profile.countryCode ?? '',
    countryName: countryName(user.profile.countryCode),
    companyName: user.profile.companyName ?? null,
    role: primaryTradeRole(user.roles),
    avatarUrl: user.profile.avatarUrl ?? null,
    initials: initialsOf(user.profile.fullName),
    createdAt: user.createdAt.toISOString(),
  };
}

/** Pluggable until the notifications module exists. */
let unreadCounter: (userId: string) => Promise<number> = async () => 0;
export function setUnreadNotificationCounter(fn: (userId: string) => Promise<number>): void {
  unreadCounter = fn;
}

// POST /auth/register
export async function register(req: Request, res: Response): Promise<void> {
  const b = req.body as WebRegisterBody;
  const identifier =
    b.method === 'email' ? normalizeEmail(b.email ?? '')! : normalizePhone(b.mobile ?? '')!;
  const info = await registerWeb({
    registration: {
      method: b.method,
      identifier,
      fullName: b.fullName,
      role: b.role,
      companyName: b.companyName || undefined,
      country: b.country,
      acceptedTermsVersion: b.acceptedTermsVersion,
      email: b.method === 'email' ? identifier : normalizeEmail(b.email ?? '') ?? undefined,
      phone: b.method === 'email' ? normalizePhone(b.mobile ?? '') ?? undefined : identifier,
    },
    ip: clientIp(req),
  });
  noStore(res);
  res.status(201).json(challengeBody(info));
}

// POST /auth/otp/request — identical response whether or not the account exists
export async function otpRequest(req: Request, res: Response): Promise<void> {
  const b = req.body as WebOtpRequestBody;
  const identifier = b.method === 'email' ? normalizeEmail(b.identifier)! : normalizePhone(b.identifier)!;
  const info = await requestWebOtp({ method: b.method, identifier, intent: b.intent, ip: clientIp(req) });
  noStore(res);
  res.status(200).json(challengeBody(info));
}

// POST /auth/otp/resend (W-7: mirrors mobile)
export async function otpResend(req: Request, res: Response): Promise<void> {
  const { challengeId } = req.body as { challengeId: string };
  const { info } = await resendWebOtp({ challengeId, ip: clientIp(req) });
  noStore(res);
  res.status(200).json(challengeBody(info));
}

// POST /auth/otp/verify
export async function otpVerify(req: Request, res: Response): Promise<void> {
  const { challengeId, code } = req.body as { challengeId: string; code: string };
  const { tokens, user, isNewAccount } = await verifyWebOtp({
    challengeId,
    code,
    device: deviceFromRequest(req),
  });
  setWebRefreshCookie(res, tokens.refreshToken);
  noStore(res);
  res.status(200).json({
    accessToken: tokens.accessToken,
    expiresIn: tokens.expiresIn,
    tokenType: 'Bearer',
    user: toWebUserProfile(user),
    kycStatus: toWebKycStatus(user.kycStatus),
    isNewAccount,
  });
}

// POST /auth/refresh — refresh cookie only, no body
export async function refresh(req: Request, res: Response): Promise<void> {
  const token = readCookie(req, loadEnv().WEB_REFRESH_COOKIE_NAME);
  if (!token) {
    // Distinguishable in logs from an expired session; never a redirect.
    throw new AppError({ status: 401, code: 'auth/no-refresh-token', message: 'No refresh token was sent.' });
  }
  try {
    const out = await refreshCustomerTokens({
      refreshToken: token,
      client: 'web',
      device: { ip: clientIp(req), userAgent: req.header('user-agent') ?? undefined },
    });
    // Within the 10 s grace window the winning request's cookie stays in place (no rotation).
    if (out.refreshToken) setWebRefreshCookie(res, out.refreshToken);
    noStore(res);
    res.status(200).json({ accessToken: out.accessToken, expiresIn: out.expiresIn, tokenType: 'Bearer' });
  } catch (err) {
    if (err instanceof AppError && err.status === 401) clearWebRefreshCookie(res);
    throw err;
  }
}

// POST /auth/logout — 204 regardless; works with an expired access token
export async function logout(req: Request, res: Response): Promise<void> {
  const cookie = readCookie(req, loadEnv().WEB_REFRESH_COOKIE_NAME);
  let revoked = false;
  if (cookie) revoked = await revokeSessionByRefreshToken(cookie, 'web', 'sign_out');
  if (!revoked) {
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '')?.[1];
    if (bearer) {
      const v = verifyAccessToken(bearer);
      if (v.ok && v.claims.cli === 'web') await revokeCustomerSession(v.claims.sid, v.claims.sub, 'sign_out');
    }
  }
  clearWebRefreshCookie(res);
  res.status(204).end();
}

// GET /auth/me
export async function me(req: Request, res: Response): Promise<void> {
  const { user } = getUserContext(req);
  const [kycStage, unread] = await Promise.all([getWebKycStage(user.id), unreadCounter(user.id)]);
  res.status(200).json({
    user: toWebUserProfile(user),
    kycStatus: toWebKycStatus(user.kycStatus),
    kycStage,
    roles: user.roles,
    // e.g. ["bank.examine"]. W-1: `wsToken` is intentionally absent until the realtime auth decision.
    permissions: hasRole(user.roles, 'bank_operator') ? ['bank.examine'] : [],
    unreadNotifications: unread,
  });
}

// POST /auth/password/change
export async function passwordChange(req: Request, res: Response): Promise<void> {
  const { user, session } = getUserContext(req);
  const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword: string };
  const { refreshToken } = await changeWebPassword({
    userId: user.id,
    sessionPublicId: session.publicId,
    currentPassword,
    newPassword,
  });
  if (refreshToken) setWebRefreshCookie(res, refreshToken);
  res.status(204).end();
}

// GET /auth/sessions
export async function listSessions(req: Request, res: Response): Promise<void> {
  const { user, session: current } = getUserContext(req);
  const sessions = await listActiveCustomerSessions(user.id);
  res.status(200).json({
    items: sessions.map((s) => ({
      id: s.publicId,
      device: s.device.name ?? (s.client === 'web' ? describeUserAgent(s.device.userAgent) : 'Mobile app'),
      location: s.device.location ?? 'Unknown',
      lastActiveAt: s.lastUsedAt.toISOString(),
      isCurrent: s.publicId === current.publicId,
      ipAddress: maskIp(s.device.ip),
    })),
  });
}

// DELETE /auth/sessions/{sessionId}
export async function revokeSession(req: Request, res: Response): Promise<void> {
  const { user, session: current } = getUserContext(req);
  const { sessionId } = req.params as { sessionId: string };
  if (sessionId === current.publicId) {
    throw conflict('auth/cannot-revoke-current', 'Use sign-out to end the current session.');
  }
  if (!(await revokeCustomerSession(sessionId, user.id, 'revoked_by_user'))) {
    throw notFound('resource/not-found', 'Session not found');
  }
  res.status(204).end();
}

// DELETE /auth/account — 202 scheduled; 409 while orders are open
export async function deleteAccount(req: Request, res: Response): Promise<void> {
  const { user } = getUserContext(req);
  const { reason } = req.body as { confirmation: 'DELETE'; reason?: string };
  const result = await scheduleAccountDeletion(user.id, reason);
  if (result.blocking.length > 0) {
    // `openOrderCount` is a top-level contract field, so respond directly.
    res.status(409).json({
      code: 'auth/account-has-open-orders',
      message: 'Open orders must settle before your account can be deleted.',
      openOrderCount: result.blocking.length,
      requestId: req.requestId,
    });
    return;
  }
  await revokeAllCustomerSessions(user.id, { reason: 'account_deleted' });
  clearWebRefreshCookie(res);
  res.status(202).json({
    scheduledDeletionAt: result.scheduledDeletionAt!.toISOString(),
    openOrderCount: 0,
  });
}

