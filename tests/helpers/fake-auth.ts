import type { NextFunction, Request, Response } from 'express';
import { forbidden, unauthorized } from '../../src/common/errors/app-error.js';

/**
 * Hermetic stand-in for src/modules/auth/auth.middleware.ts. Tests identify callers with
 * headers: x-test-user (required for requireUser), x-test-kyc (default verified), x-test-tier.
 */
function bind(req: Request): boolean {
  const userId = req.header('x-test-user');
  if (!userId) return false;
  req.actor = {
    kind: 'user',
    userId,
    roles: ['both'],
    kycStatus: req.header('x-test-kyc') ?? 'verified',
    tier: Number(req.header('x-test-tier') ?? 2),
    sessionId: 'ses_test',
    client: req.apiClient === 'mobile' ? 'mobile' : 'web',
  };
  return true;
}

export const requireUser = (req: Request, _res: Response, next: NextFunction) =>
  bind(req)
    ? next()
    : next(unauthorized(req.apiClient === 'mobile' ? 'auth/token-invalid' : 'auth/session-expired', 'Authentication required'));

export const optionalUser = (req: Request, _res: Response, next: NextFunction) => {
  bind(req);
  next();
};

export function kycGateError(client: string) {
  return forbidden(client === 'mobile' ? 'kyc/not-verified' : 'kyc/not-approved', 'KYC required');
}

export const requireKyc = (req: Request, _res: Response, next: NextFunction) =>
  req.actor?.kind === 'user' && req.actor.kycStatus === 'verified' ? next() : next(kycGateError(req.apiClient));

export const requireTransactionPin = (_req: Request, _res: Response, next: NextFunction) => next();
export const requireRole = () => (_req: Request, _res: Response, next: NextFunction) => next();
