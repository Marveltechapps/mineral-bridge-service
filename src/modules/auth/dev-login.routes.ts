import { Router, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { validate } from '../../common/middleware/validate.js';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { loadEnv } from '../../config/env.js';
import * as ctrl from './dev-login.controller.js';
import { devLoginBody, devLoginVerifyBody } from './dev-login.schemas.js';

function devLoginLimiter(): RequestHandler {
  const env = loadEnv();
  return rateLimit({
    windowMs: 60_000,
    limit: env.AUTH_RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === 'test',
    validate: false,
    handler: (_req, res) => {
      res.setHeader('Retry-After', '60');
      res.status(429).json({
        code: 'auth/dev-login-rate-limited',
        message: 'Too many attempts. Try again shortly.',
      });
    },
  });
}

/** Customer development login under `/v1`. The audience is always the application, never admin. */
export function mountCustomerDevLogin(router: Router): void {
  const limiter = devLoginLimiter();
  router.get('/auth/dev-login', limiter, asyncHandler(ctrl.customerDevStatus));
  router.post('/auth/dev-login', limiter, validate({ body: devLoginBody }), asyncHandler(ctrl.customerDevStart));
  router.post(
    '/auth/dev-login/verify',
    limiter,
    validate({ body: devLoginVerifyBody }),
    asyncHandler(ctrl.customerDevVerify),
  );
}

/** Admin development login under `/admin/v1`. Ordinary application credentials are not accepted. */
export function mountAdminDevLogin(router: Router): void {
  const limiter = devLoginLimiter();
  router.get('/auth/dev-login', limiter, asyncHandler(ctrl.adminDevStatus));
  router.post('/auth/dev-login', limiter, validate({ body: devLoginBody }), asyncHandler(ctrl.adminDevStart));
  router.post(
    '/auth/dev-login/verify',
    limiter,
    validate({ body: devLoginVerifyBody }),
    asyncHandler(ctrl.adminDevVerify),
  );
}
