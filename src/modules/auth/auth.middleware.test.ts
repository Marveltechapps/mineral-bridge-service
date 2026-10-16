import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../common/errors/app-error.js';
import { hashToken } from '../../common/utils/crypto.js';
import { deriveCsrfToken } from '../sessions/session.service.js';
import {
  customerAuthError,
  kycGateError,
  requireCsrf,
  requireKyc,
  requireRole,
  requireStaffPermission,
  requireUnlockedConsole,
} from './auth.middleware.js';

type Actor = NonNullable<Request['actor']>;

function run(handler: RequestHandler, req: Partial<Request>): AppError | null {
  let result: unknown = 'pending';
  const next: NextFunction = (err?: unknown) => {
    result = err ?? null;
  };
  const full = { method: 'POST', header: () => undefined, ...req } as unknown as Request;
  handler(full, {} as Response, next);
  return result as AppError | null;
}

const customer = (over: Partial<Extract<Actor, { kind: 'user' }>>): Actor => ({
  kind: 'user',
  userId: 'u1',
  roles: ['buyer'],
  kycStatus: 'verified',
  sessionId: 'ses_1',
  client: 'mobile',
  ...over,
});

describe('requireKyc', () => {
  it('passes verified users', () => {
    expect(run(requireKyc, { actor: customer({}) })).toBeNull();
  });

  it.each(['none', 'pending', 'rejected'] as const)('blocks %s on mobile with kyc/not-verified', (status) => {
    const err = run(requireKyc, { actor: customer({ kycStatus: status, client: 'mobile' }) });
    expect(err).toMatchObject({ status: 403, code: 'kyc/not-verified', kycStatus: status });
  });

  it('treats pending as NOT sufficient on web, with kyc/not-approved and the web vocabulary', () => {
    const pending = run(requireKyc, { actor: customer({ kycStatus: 'pending', client: 'web' }) });
    expect(pending).toMatchObject({ status: 403, code: 'kyc/not-approved', kycStatus: 'pending' });
    const none = run(requireKyc, { actor: customer({ kycStatus: 'none', client: 'web' }) });
    expect(none).toMatchObject({ code: 'kyc/not-approved', kycStatus: 'unverified' });
  });

  it('is a 401 when there is no authenticated user', () => {
    expect(run(requireKyc, { apiClient: 'mobile' })).toMatchObject({ status: 401 });
  });

  it('kycGateError never uses the other client vocabulary', () => {
    expect(kycGateError('mobile', 'none').kycStatus).toBe('none');
    expect(kycGateError('web', 'none').kycStatus).toBe('unverified');
  });
});

describe('requireRole', () => {
  it('requires bank_operator for bank routes', () => {
    const h = requireRole('bank_operator');
    expect(run(h, { actor: customer({ roles: ['buyer'] }) })).toMatchObject({ status: 403, code: 'auth/role-required' });
    expect(run(h, { actor: customer({ roles: ['buyer', 'bank_operator'] }) })).toBeNull();
  });

  it('lets "both" satisfy buyer and seller', () => {
    expect(run(requireRole('seller'), { actor: customer({ roles: ['both'] }) })).toBeNull();
    expect(run(requireRole('buyer'), { actor: customer({ roles: ['both'] }) })).toBeNull();
    expect(run(requireRole('seller'), { actor: customer({ roles: ['buyer'] }) })).toMatchObject({ status: 403 });
  });
});

describe('customerAuthError', () => {
  it('uses mobile codes for mobile and session-expired for web', () => {
    expect(customerAuthError('mobile', 'expired').code).toBe('auth/token-expired');
    expect(customerAuthError('mobile', 'invalid').code).toBe('auth/token-invalid');
    expect(customerAuthError('web', 'expired').code).toBe('auth/session-expired');
    expect(customerAuthError('web', 'missing').code).toBe('auth/session-expired');
  });
});

const staff = (over: Partial<Extract<Actor, { kind: 'staff' }>> = {}): Actor => ({
  kind: 'staff',
  staffId: 's1',
  role: 'Trading Desk Manager',
  permissions: { orders: 'edit', vault: 'view', pricing: 'none' },
  sessionId: 'SES-1',
  sessionState: 'active',
  csrfTokenHash: hashToken(deriveCsrfToken('session-token')),
  ...over,
});

describe('requireCsrf', () => {
  const token = deriveCsrfToken('session-token');
  const withHeader = (value: string | undefined, method = 'POST'): Partial<Request> => ({
    method,
    actor: staff(),
    header: ((name: string) => (name.toLowerCase() === 'x-csrf-token' ? value : undefined)) as Request['header'],
  });

  it('accepts the matching token', () => {
    expect(run(requireCsrf, withHeader(token))).toBeNull();
  });
  it('rejects missing and wrong tokens with 403 auth/csrf', () => {
    expect(run(requireCsrf, withHeader(undefined))).toMatchObject({ status: 403, code: 'auth/csrf' });
    expect(run(requireCsrf, withHeader('nope'))).toMatchObject({ status: 403, code: 'auth/csrf' });
  });
  it('does not require the token on safe methods', () => {
    expect(run(requireCsrf, withHeader(undefined, 'GET'))).toBeNull();
  });
  it('is a 401 without a staff session', () => {
    expect(run(requireCsrf, { method: 'POST' })).toMatchObject({ status: 401, code: 'auth/session-expired' });
  });
});

describe('requireUnlockedConsole', () => {
  it('passes active and blocks locked sessions with auth/console-locked', () => {
    expect(run(requireUnlockedConsole, { actor: staff() })).toBeNull();
    expect(run(requireUnlockedConsole, { actor: staff({ sessionState: 'locked' }) })).toMatchObject({
      status: 401,
      code: 'auth/console-locked',
    });
  });
});

describe('requireStaffPermission', () => {
  it('lets edit satisfy view and edit', () => {
    expect(run(requireStaffPermission('orders', 'edit'), { actor: staff() })).toBeNull();
    expect(run(requireStaffPermission('orders', 'view'), { actor: staff() })).toBeNull();
  });
  it('lets view satisfy view only', () => {
    expect(run(requireStaffPermission('vault', 'view'), { actor: staff() })).toBeNull();
    expect(run(requireStaffPermission('vault', 'edit'), { actor: staff() })).toMatchObject({
      status: 403,
      code: 'auth/forbidden',
    });
  });
  it('denies none and missing modules', () => {
    expect(run(requireStaffPermission('pricing', 'view'), { actor: staff() })).toMatchObject({ status: 403 });
    expect(run(requireStaffPermission('settings', 'view'), { actor: staff() })).toMatchObject({ status: 403 });
  });
  it('implies an unlocked console', () => {
    expect(run(requireStaffPermission('orders', 'view'), { actor: staff({ sessionState: 'locked' }) })).toMatchObject({
      code: 'auth/console-locked',
    });
  });
});
