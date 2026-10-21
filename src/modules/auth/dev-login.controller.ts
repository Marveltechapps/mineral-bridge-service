import type { Request, Response } from 'express';
import { loadEnv } from '../../config/env.js';
import { setAdminSessionCookie, setWebRefreshCookie } from './auth.cookies.js';
import { clientIp, deviceFromRequest, noStore } from './auth.http.js';
import { buildMe } from './admin.auth.service.js';
import { readDevLoginConfig } from './dev-login.config.js';
import {
  developmentLoginStatus,
  startDevelopmentLogin,
  verifyAdminDevelopmentLogin,
  verifyAppDevelopmentLogin,
} from './dev-login.service.js';
import { toMobileAccount } from './mobile.auth.controller.js';
import { toWebKycStatus } from '../users/user.service.js';
import { toWebUserProfile } from './web.auth.controller.js';

function config() {
  return readDevLoginConfig(loadEnv());
}

function customerClient(req: Request): 'web' | 'mobile' {
  return req.apiClient === 'mobile' ? 'mobile' : 'web';
}

export function customerDevStatus(_req: Request, res: Response): void {
  noStore(res);
  res.status(200).json(developmentLoginStatus(config(), 'app'));
}

export async function customerDevStart(req: Request, res: Response): Promise<void> {
  const body = req.body as { email: string; password: string };
  const challenge = await startDevelopmentLogin({
    config: config(),
    audience: 'app',
    client: customerClient(req),
    email: body.email,
    password: body.password,
    ip: clientIp(req),
  });
  noStore(res);
  res.status(200).json({
    challengeId: challenge.challengeId,
    expiresIn: challenge.expiresIn,
    codeLength: challenge.codeLength,
    developmentOtp: challenge.developmentOtp,
  });
}

export async function customerDevVerify(req: Request, res: Response): Promise<void> {
  const client = customerClient(req);
  const body = req.body as { challengeId: string; code: string; rememberDevice?: boolean };
  const { user, tokens } = await verifyAppDevelopmentLogin({
    config: config(),
    client,
    challengeId: body.challengeId,
    code: body.code,
    device: deviceFromRequest(req),
    rememberDevice: body.rememberDevice,
  });
  noStore(res);
  if (client === 'mobile') {
    res.status(200).json({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      tokenType: 'Bearer',
      isNewAccount: false,
      account: toMobileAccount(user),
    });
    return;
  }
  setWebRefreshCookie(res, tokens.refreshToken, tokens.session.persistent !== false);
  res.status(200).json({
    accessToken: tokens.accessToken,
    expiresIn: tokens.expiresIn,
    tokenType: 'Bearer',
    user: toWebUserProfile(user),
    kycStatus: toWebKycStatus(user.kycStatus),
    isNewAccount: false,
  });
}

export function adminDevStatus(_req: Request, res: Response): void {
  noStore(res);
  res.status(200).json(developmentLoginStatus(config(), 'admin'));
}

export async function adminDevStart(req: Request, res: Response): Promise<void> {
  const body = req.body as { email: string; password: string };
  const challenge = await startDevelopmentLogin({
    config: config(),
    audience: 'admin',
    client: 'admin',
    email: body.email,
    password: body.password,
    ip: clientIp(req),
  });
  noStore(res);
  res.status(200).json({
    challengeId: challenge.challengeId,
    channel: 'development',
    maskedDestination: 'Shown on this screen',
    expiresAt: challenge.expiresAt,
    resendAvailableAt: challenge.expiresAt,
    codeLength: challenge.codeLength,
    developmentOtp: challenge.developmentOtp,
  });
}

export async function adminDevVerify(req: Request, res: Response): Promise<void> {
  const body = req.body as { challengeId: string; code: string };
  const { staff, issued } = await verifyAdminDevelopmentLogin({
    config: config(),
    challengeId: body.challengeId,
    code: body.code,
    device: deviceFromRequest(req),
  });
  setAdminSessionCookie(res, issued.sessionToken);
  res.setHeader('X-CSRF-Token', issued.csrfToken);
  noStore(res);
  res.status(200).json({
    me: buildMe(staff, issued.session, issued.csrfToken),
    redirectTo: '/overview',
  });
}
