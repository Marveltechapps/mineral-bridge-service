import { Router } from 'express';
import { validate } from '../../common/middleware/validate.js';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireTransactionPin, requireUser } from './auth.middleware.js';
import * as ctrl from './mobile.auth.controller.js';
import { mountCustomerDevLogin } from './dev-login.routes.js';
import {
  mobileAlternateChannelBody,
  mobileOtpRequestBody,
  mobileOtpResendBody,
  mobileOtpVerifyBody,
  mobilePinBody,
  mobileRefreshBody,
  mobileSignOutBody,
  sessionIdParams,
} from './mobile.auth.schemas.js';

/**
 * Mobile auth routes, relative to `/v1`. Mount through `createCustomerAuthRouter()`
 * (customer.routes.ts) so colliding paths dispatch by client.
 */
export function createMobileAuthRouter(): Router {
  const r = Router();

  mountCustomerDevLogin(r);
  // Pre-auth (#1–#5)
  r.post('/auth/otp/request', validate({ body: mobileOtpRequestBody }), asyncHandler(ctrl.otpRequest));
  r.post('/auth/otp/verify', validate({ body: mobileOtpVerifyBody }), asyncHandler(ctrl.otpVerify));
  r.post('/auth/otp/resend', validate({ body: mobileOtpResendBody }), asyncHandler(ctrl.otpResend));
  r.post(
    '/auth/otp/alternate-channel',
    validate({ body: mobileAlternateChannelBody }),
    asyncHandler(ctrl.otpAlternateChannel),
  );
  r.post('/auth/token/refresh', validate({ body: mobileRefreshBody }), asyncHandler(ctrl.tokenRefresh));

  // Authenticated (#6–#10)
  r.post('/auth/sign-out', requireUser, validate({ body: mobileSignOutBody }), asyncHandler(ctrl.signOut));
  r.delete('/auth/account', requireUser, requireTransactionPin, asyncHandler(ctrl.deleteAccount));
  r.get('/auth/sessions', requireUser, asyncHandler(ctrl.listSessions));
  r.delete(
    '/auth/sessions/:sessionId',
    requireUser,
    validate({ params: sessionIdParams }),
    asyncHandler(ctrl.revokeSession),
  );
  r.put('/auth/pin', requireUser, validate({ body: mobilePinBody }), asyncHandler(ctrl.putPin));

  return r;
}
