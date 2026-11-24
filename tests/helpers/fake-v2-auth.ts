import type { NextFunction, Request, Response } from 'express';
import { unauthorized } from '../../src/common/errors/app-error.js';
import { userRepository } from '../../src/modules/users/user.repository.js';
import type { CustomerSessionRecord } from '../../src/modules/sessions/session.types.js';
import type { UserContext } from '../../src/modules/auth/auth.middleware.js';

const userContexts = new WeakMap<Request, UserContext>();

const stubSession = { id: 'ses_test_v2' } as CustomerSessionRecord;

export async function requireUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const userId = req.header('x-test-user');
  if (!userId) {
    next(unauthorized('auth/token-invalid', 'Authentication required'));
    return;
  }
  const user = await userRepository.findById(userId);
  if (!user) {
    next(unauthorized('auth/token-invalid', 'Authentication required'));
    return;
  }
  userContexts.set(req, { user, session: stubSession });
  next();
}

export function getUserContext(req: Request): UserContext {
  const ctx = userContexts.get(req);
  if (!ctx) throw unauthorized('auth/token-invalid', 'Authentication required');
  return ctx;
}

export const optionalUser = (req: Request, _res: Response, next: NextFunction) => {
  void requireUser(req, _res, next);
};