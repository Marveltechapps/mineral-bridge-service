import { Router } from 'express';
import { validate } from '../../common/middleware/validate.js';
import { asyncHandler } from '../../common/utils/async-handler.js';
import * as ctrl from './admin.auth.controller.js';
import {
  adminOtpResendBody,
  adminOtpVerifyBody,
  adminPasswordResetBody,
  adminPasswordResetConfirmBody,
  adminSignInBody,
  adminSsoCallbackBody,
  adminSsoStartBody,
  adminUnlockBody,
} from './admin.auth.schemas.js';
import { attachStaffCsrf, optionalStaff, requireCsrf, requireStaff, requireUnlockedConsole } from './auth.middleware.js';
import { mountAdminDevLogin } from './dev-login.routes.js';

/**
 * Admin auth under `/admin/v1`.
 *
 *  - Public (no session): sign-in, sso/*, otp/*, password-reset*.
 *  - Session, CSRF, *locked allowed*: unlock, sign-out, GET /me (and lock, which is idempotent).
 *  - Session, CSRF, unlocked only: refresh. Refresh rotates the cookie.
 *    Ordinary requests slide the idle deadline without rotating, so other tabs stay signed in.
 */
export function createAdminAuthRouter(): Router {
  const r = Router();

  mountAdminDevLogin(r);
  r.post('/auth/sign-in', validate({ body: adminSignInBody }), asyncHandler(ctrl.signInHandler));
  r.post('/auth/sso/start', validate({ body: adminSsoStartBody }), asyncHandler(ctrl.ssoStart));
  r.post('/auth/sso/callback', validate({ body: adminSsoCallbackBody }), asyncHandler(ctrl.ssoCallback));
  r.post('/auth/otp/verify', validate({ body: adminOtpVerifyBody }), asyncHandler(ctrl.otpVerify));
  r.post('/auth/otp/resend', validate({ body: adminOtpResendBody }), asyncHandler(ctrl.otpResend));

  // Signed-in callers (Profile) may omit `email`; anonymous callers send it.
  r.post(
    '/auth/password-reset',
    optionalStaff,
    validate({ body: adminPasswordResetBody }),
    asyncHandler(ctrl.passwordReset),
  );
  r.post(
    '/auth/password-reset/confirm',
    validate({ body: adminPasswordResetConfirmBody }),
    asyncHandler(ctrl.passwordResetConfirm),
  );

  r.post('/auth/refresh', requireStaff, requireCsrf, requireUnlockedConsole, attachStaffCsrf, asyncHandler(ctrl.refresh));
  r.post('/auth/lock', requireStaff, requireCsrf, attachStaffCsrf, asyncHandler(ctrl.lock));
  r.post('/auth/unlock', requireStaff, requireCsrf, attachStaffCsrf, validate({ body: adminUnlockBody }), asyncHandler(ctrl.unlock));
  r.post('/auth/sign-out', requireStaff, requireCsrf, attachStaffCsrf, asyncHandler(ctrl.signOut));
  r.get('/me', requireStaff, attachStaffCsrf, asyncHandler(ctrl.me));

  return r;
}
