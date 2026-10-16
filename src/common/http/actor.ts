import type { Request } from 'express';
import { unauthorized } from '../errors/app-error.js';
import type { AuthActor } from '../types/express-aug.js';

export type UserActor = Extract<AuthActor, { kind: 'user' }>;

/** The authenticated customer, or `undefined` for guests / staff. */
export function getUserActor(req: Request): UserActor | undefined {
  return req.actor?.kind === 'user' ? req.actor : undefined;
}

/** The authenticated customer; throws a per-client 401 when absent (auth middleware normally ran first). */
export function currentUser(req: Request): UserActor {
  const a = getUserActor(req);
  if (!a) {
    throw req.apiClient === 'mobile'
      ? unauthorized('auth/token-invalid', 'Authentication required')
      : unauthorized('auth/session-expired', 'Your session has expired. Sign in again.');
  }
  return a;
}

export const currentUserId = (req: Request): string => currentUser(req).userId;
