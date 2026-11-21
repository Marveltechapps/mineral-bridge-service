import type { Request, Response } from 'express';
import { loadEnv } from '../../config/env.js';
import { readCookie } from './auth.cookies.js';
import { setV2WebRefreshCookie, clearV2WebRefreshCookie } from './auth.cookies.js';
import { clientIp, deviceFromRequest, noStore } from './auth.http.js';
import { getUserContext } from './auth.middleware.js';
import {
  toMeDto,
  v2ListSessions,
  v2Logout,
  v2Refresh,
  v2Register,
  v2RequestOtp,
  v2ResendOtp,
  v2RevokeSession,
  v2VerifyOtp,
} from './v2.auth.service.js';
import type {
  V2OtpRequestBody,
  V2OtpVerifyBody,
  V2RegisterBody,
} from './v2.auth.schemas.js';
import type { ChallengeInfo } from './otp.service.js';

function clientOf(req: Request): 'mobile' | 'web' {
  return req.apiClient === 'mobile' ? 'mobile' : 'web';
}

function challenge202(info: ChallengeInfo) {
  return {
    challengeId: info.challengeId,
    maskedDestination: info.maskedDestination,
    codeLength: info.codeLength,
    expiresAt: info.expiresAt.toISOString(),
    resendAvailableAt: info.resendAvailableAt.toISOString(),
    ...(info.developmentOtp ? { developmentOtp: info.developmentOtp } : {}),
  };
}

export async function otpRequest(req: Request, res: Response): Promise<void> {
  const body = req.body as V2OtpRequestBody;
  const info = await v2RequestOtp({
    client: clientOf(req),
    intent: body.intent,
    channel: body.channel,
    identifier: body.identifier,
    fullName: body.fullName,
    ip: clientIp(req),
  });
  noStore(res);
  res.status(202).json(challenge202(info));
}

export async function otpResend(req: Request, res: Response): Promise<void> {
  const body = req.body as { challengeId: string; channel?: 'whatsapp' | 'sms' | 'email' };
  const info = await v2ResendOtp({
    client: clientOf(req),
    challengeId: body.challengeId,
    channel: body.channel,
    ip: clientIp(req),
  });
  noStore(res);
  res.status(202).json(challenge202(info));
}

export async function otpVerify(req: Request, res: Response): Promise<void> {
  const body = req.body as V2OtpVerifyBody;
  const client = clientOf(req);
  const result = await v2VerifyOtp({
    client,
    challengeId: body.challengeId,
    code: body.code,
    keepSignedIn: body.keepSignedIn,
    device: deviceFromRequest(req, body.device),
  });
  noStore(res);
  if (result.status === 'needs_registration') {
    res.status(200).json({
      status: 'needs_registration',
      registrationToken: result.registrationToken,
      expiresIn: result.expiresIn,
    });
    return;
  }
  if (client === 'web') {
    setV2WebRefreshCookie(res, result.tokens.refreshToken, body.keepSignedIn !== false);
  }
  res.status(200).json({
    status: 'signed_in',
    accessToken: result.tokens.accessToken,
    expiresIn: result.tokens.expiresIn,
    ...(client === 'mobile' ? { refreshToken: result.tokens.refreshToken } : {}),
    me: toMeDto(result.user),
  });
}

export async function register(req: Request, res: Response): Promise<void> {
  const body = req.body as V2RegisterBody;
  const client = clientOf(req);
  const { tokens, user } = await v2Register({
    client,
    registrationToken: body.registrationToken,
    fullName: body.fullName,
    role: body.role,
    buyerType: body.buyerType,
    sellerType: body.sellerType,
    businessName: body.businessName,
    countryCode: body.countryCode,
    termsVersion: body.termsVersion,
    device: deviceFromRequest(req),
  });
  noStore(res);
  if (client === 'web') setV2WebRefreshCookie(res, tokens.refreshToken, true);
  res.status(201).json({
    status: 'signed_in',
    accessToken: tokens.accessToken,
    expiresIn: tokens.expiresIn,
    ...(client === 'mobile' ? { refreshToken: tokens.refreshToken } : {}),
    me: toMeDto(user),
  });
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const client = clientOf(req);
  const env = loadEnv();
  const bodyToken = (req.body as { refreshToken?: string })?.refreshToken;
  const cookieToken = readCookie(req, env.WEB_REFRESH_COOKIE_NAME);
  const refreshToken = client === 'mobile' ? bodyToken : cookieToken ?? bodyToken;
  if (!refreshToken) {
    res.status(401).json({ code: 'auth/session-expired', message: 'Your session has expired.' });
    return;
  }
  const outcome = await v2Refresh({
    client,
    refreshToken,
    device: deviceFromRequest(req),
  });
  noStore(res);
  if (client === 'web' && outcome.refreshToken) {
    setV2WebRefreshCookie(res, outcome.refreshToken, true);
  }
  res.status(200).json({
    accessToken: outcome.accessToken,
    expiresIn: outcome.expiresIn,
    ...(client === 'mobile' && outcome.refreshToken ? { refreshToken: outcome.refreshToken } : {}),
  });
}

export async function logout(req: Request, res: Response): Promise<void> {
  const ctx = getUserContext(req);
  await v2Logout({ userId: ctx.user.id, sessionPublicId: ctx.session.publicId });
  clearV2WebRefreshCookie(res);
  noStore(res);
  res.status(204).send();
}

export async function listSessions(req: Request, res: Response): Promise<void> {
  const ctx = getUserContext(req);
  const items = await v2ListSessions({
    userId: ctx.user.id,
    currentSessionId: ctx.session.publicId,
    client: clientOf(req),
  });
  res.status(200).json({ items });
}

export async function revokeSession(req: Request, res: Response): Promise<void> {
  const ctx = getUserContext(req);
  await v2RevokeSession({ userId: ctx.user.id, sessionId: req.params.id! });
  res.status(204).send();
}
