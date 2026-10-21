import { Router } from 'express';
import { validate } from '../../common/middleware/validate.js';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireUser, requireWebCookieOrigin } from './auth.middleware.js';
import * as ctrl from './web.auth.controller.js';
import { mountCustomerDevLogin } from './dev-login.routes.js';
import {
  webDeleteAccountBody,
  webOtpRequestBody,
  webOtpResendBody,
  webOtpVerifyBody,
  webPasswordChangeBody,
  webRegisterBody,
  webSessionIdParams,
} from './web.auth.schemas.js';

/**
 * Web auth routes, relative to `/v1`. Mount through `createCustomerAuthRouter()`.
 *
 * Cookie-authenticated mutations (`/auth/refresh`, `/auth/logout`) sit behind
 * `requireWebCookieOrigin` (Origin allowlist, W-2). The `mb_refresh` cookie is scoped to
 * `Path=/v1/auth` (W-3) — see auth.cookies.ts.
 */
export function createWebAuthRouter(): Router {
  const r = Router();

  // Public
  mountCustomerDevLogin(r);
  r.get('/auth/verification-options', asyncHandler(ctrl.verificationOptions));
  r.post('/auth/register', validate({ body: webRegisterBody }), asyncHandler(ctrl.register));
  r.post('/auth/otp/request', validate({ body: webOtpRequestBody }), asyncHandler(ctrl.otpRequest));
  r.post('/auth/otp/verify', validate({ body: webOtpVerifyBody }), asyncHandler(ctrl.otpVerify));
  r.post('/auth/otp/resend', validate({ body: webOtpResendBody }), asyncHandler(ctrl.otpResend));

  // Refresh cookie only
  r.post('/auth/refresh', requireWebCookieOrigin, asyncHandler(ctrl.refresh));
  r.post('/auth/logout', requireWebCookieOrigin, asyncHandler(ctrl.logout));

  // Authenticated
  r.get('/auth/me', requireUser, asyncHandler(ctrl.me));
  r.post(
    '/auth/password/change',
    requireUser,
    validate({ body: webPasswordChangeBody }),
    asyncHandler(ctrl.passwordChange),
  );
  r.get('/auth/sessions', requireUser, asyncHandler(ctrl.listSessions));
  r.delete(
    '/auth/sessions/:sessionId',
    requireUser,
    validate({ params: webSessionIdParams }),
    asyncHandler(ctrl.revokeSession),
  );
  r.delete(
    '/auth/account',
    requireUser,
    validate({ body: webDeleteAccountBody }),
    asyncHandler(ctrl.deleteAccount),
  );

  return r;
}
