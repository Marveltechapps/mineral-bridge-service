import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { validate } from '../../common/middleware/validate.js';
import { requireUser, requireWebCookieOrigin } from './auth.middleware.js';
import * as ctrl from './v2.auth.controller.js';
import {
  v2OtpRequestSchema,
  v2OtpResendSchema,
  v2OtpVerifySchema,
  v2RefreshSchema,
  v2RegisterSchema,
} from './v2.auth.schemas.js';
import { z } from 'zod';

export function createV2AuthRouter(): Router {
  const r = Router();

  r.post('/otp/request', validate({ body: v2OtpRequestSchema }), asyncHandler(ctrl.otpRequest));
  r.post('/otp/resend', validate({ body: v2OtpResendSchema }), asyncHandler(ctrl.otpResend));
  r.post('/otp/verify', validate({ body: v2OtpVerifySchema }), asyncHandler(ctrl.otpVerify));
  r.post('/register', validate({ body: v2RegisterSchema }), asyncHandler(ctrl.register));

  r.post(
    '/refresh',
    (req, res, next) => {
      // Web cookie refresh needs origin/CSRF markers; mobile sends body refreshToken.
      if (req.apiClient === 'web') return requireWebCookieOrigin(req, res, next);
      next();
    },
    validate({ body: v2RefreshSchema }),
    asyncHandler(ctrl.refresh),
  );

  r.post('/logout', requireUser, asyncHandler(ctrl.logout));
  r.get('/sessions', requireUser, asyncHandler(ctrl.listSessions));
  r.delete(
    '/sessions/:id',
    requireUser,
    validate({ params: z.object({ id: z.string().min(3) }) }),
    asyncHandler(ctrl.revokeSession),
  );

  return r;
}
