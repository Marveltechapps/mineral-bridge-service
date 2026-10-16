import type { Request, Response } from 'express';
import { conflict, notFound, unprocessable } from '../../common/errors/app-error.js';
import { isNigerianMobile, normalizePhone } from '../../common/utils/phone.js';
import {
  listActiveCustomerSessions,
  revokeAllCustomerSessions,
  revokeCustomerSession,
} from '../sessions/session.service.js';
import { deleteAccountNow, setPin } from '../users/user.service.js';
import { TIER_LABELS, type UserRecord } from '../users/user.types.js';
import { getUserContext } from './auth.middleware.js';
import { clientIp, deviceFromRequest, describeUserAgent, noStore } from './auth.http.js';
import {
  mobileNextStep,
  refreshCustomerTokens,
  requestMobileOtp,
  resendMobileOtp,
  signOutCustomer,
  verifyMobileOtp,
} from './auth.service.js';
import type { ChallengeInfo } from './otp.service.js';
import type {
  MobileOtpRequestBody,
  MobileOtpVerifyBody,
} from './mobile.auth.schemas.js';

/** Mobile `acc_…` ids are a presentation prefix over the ObjectId (X-3). */
export const toMobileAccountId = (id: string): string => `acc_${id}`;

export function parseMobilePhone(raw: string): string {
  const e164 = normalizePhone(raw);
  if (!e164 || !isNigerianMobile(e164)) {
    throw unprocessable('Not a valid Nigerian mobile number.', { phone: 'Enter a valid Nigerian mobile number' }, 'auth/invalid-phone');
  }
  return e164;
}

/**
 * Body of #1/#3/#4. `accountExists` is part of the contract, but returning the real value to an
 * unauthenticated caller lets anyone enumerate registered numbers, which the contract itself
 * forbids ("return the same shape either way"). We therefore echo the caller's own intent, which
 * carries no information; the real answer reaches the client after verification as
 * `isNewAccount` (verify treats an unknown number as sign-up regardless of intent).
 */
function otpBody(info: ChallengeInfo, intent: string) {
  return {
    challengeId: info.challengeId,
    expiresIn: info.expiresInSeconds,
    resendAfter: info.resendAfterSeconds,
    channel: info.channel,
    maskedPhone: info.maskedDestination,
    accountExists: intent === 'login',
  };
}

export function toMobileAccount(user: UserRecord) {
  const tier = user.tierChosenAt ? { id: user.tier, ...TIER_LABELS[user.tier] } : null;
  return {
    id: toMobileAccountId(user.id),
    fullName: user.profile.fullName ?? null,
    phone: user.phone ?? null,
    tier,
    kyc: { status: user.kycStatus },
    onboarding: { nextStep: mobileNextStep(user) },
  };
}

// #1
export async function otpRequest(req: Request, res: Response): Promise<void> {
  const body = req.body as MobileOtpRequestBody;
  const phone = parseMobilePhone(body.phone);
  const info = await requestMobileOtp({ phone, intent: body.intent, channel: body.channel, ip: clientIp(req) });
  noStore(res);
  res.status(200).json(otpBody(info, body.intent));
}

// #2
export async function otpVerify(req: Request, res: Response): Promise<void> {
  const body = req.body as MobileOtpVerifyBody;
  const phone = parseMobilePhone(body.phone);
  const { tokens, user, isNewAccount } = await verifyMobileOtp({
    challengeId: body.challengeId,
    phone,
    code: body.code,
    device: deviceFromRequest(req, body.device),
  });
  noStore(res);
  res.status(200).json({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
    tokenType: 'Bearer',
    isNewAccount,
    account: toMobileAccount(user),
  });
}

// #3
export async function otpResend(req: Request, res: Response): Promise<void> {
  const { challengeId } = req.body as { challengeId: string };
  const { info, challenge } = await resendMobileOtp({ challengeId, ip: clientIp(req) });
  noStore(res);
  res.status(200).json(otpBody(info, challenge.intent));
}

// #4
export async function otpAlternateChannel(req: Request, res: Response): Promise<void> {
  const { challengeId, channel } = req.body as { challengeId: string; channel: 'voice' | 'whatsapp' };
  const { info, challenge } = await resendMobileOtp({ challengeId, channel, ip: clientIp(req) });
  noStore(res);
  res.status(200).json(otpBody(info, challenge.intent));
}

// #5
export async function tokenRefresh(req: Request, res: Response): Promise<void> {
  const { refreshToken } = req.body as { refreshToken: string };
  const out = await refreshCustomerTokens({
    refreshToken,
    client: 'mobile',
    device: { ip: clientIp(req), userAgent: req.header('user-agent') ?? undefined },
  });
  noStore(res);
  res.status(200).json({
    accessToken: out.accessToken,
    refreshToken: out.refreshToken,
    expiresIn: out.expiresIn,
    tokenType: 'Bearer',
  });
}

// #6
export async function signOut(req: Request, res: Response): Promise<void> {
  const { user, session } = getUserContext(req);
  const { allDevices } = req.body as { allDevices?: boolean };
  await signOutCustomer({ userId: user.id, sessionPublicId: session.publicId, allDevices });
  res.status(204).end();
}

// #7 — runs behind `requireTransactionPin`
export async function deleteAccount(req: Request, res: Response): Promise<void> {
  const { user } = getUserContext(req);
  const blocking = await deleteAccountNow(user.id, 'user_request');
  if (blocking.length > 0) {
    // `blockingOrders` is a top-level field in the contract, so respond directly.
    res.status(409).json({
      code: 'auth/account-deletion-blocked',
      message: 'Active orders must be settled before you can delete your account.',
      blockingOrders: blocking,
      requestId: req.requestId,
    });
    return;
  }
  await revokeAllCustomerSessions(user.id, { reason: 'account_deleted' });
  res.status(204).end();
}

// #8
export async function listSessions(req: Request, res: Response): Promise<void> {
  const { user, session: current } = getUserContext(req);
  const sessions = await listActiveCustomerSessions(user.id);
  res.status(200).json({
    data: sessions.map((s) => ({
      id: s.publicId,
      deviceName: s.device.name ?? (s.client === 'web' ? describeUserAgent(s.device.userAgent) : 'Mobile device'),
      platform: s.device.platform ?? (s.client === 'web' ? 'web' : 'unknown'),
      current: s.publicId === current.publicId,
      lastActiveAt: s.lastUsedAt.toISOString(),
      location: s.device.location ?? null,
    })),
    meta: { total: sessions.length },
  });
}

// #9
export async function revokeSession(req: Request, res: Response): Promise<void> {
  const { user, session: current } = getUserContext(req);
  const { sessionId } = req.params as { sessionId: string };
  if (sessionId === current.publicId) {
    throw conflict('auth/cannot-revoke-current', 'Use sign-out to end the current session.');
  }
  const revoked = await revokeCustomerSession(sessionId, user.id, 'revoked_by_user');
  if (!revoked) throw notFound('resource/not-found', 'Session not found');
  res.status(204).end();
}

// #10
export async function putPin(req: Request, res: Response): Promise<void> {
  const { user } = getUserContext(req);
  const { newPin, currentPin } = req.body as { newPin: string; currentPin?: string };
  await setPin(user.id, newPin, currentPin);
  res.status(204).end();
}
