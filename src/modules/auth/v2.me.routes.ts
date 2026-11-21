import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { validate } from '../../common/middleware/validate.js';
import { requireUser } from './auth.middleware.js';
import * as ctrl from './v2.me.controller.js';
import {
  v2BusinessTypeSchema,
  v2ContactChangeSchema,
  v2ContactChangeVerifySchema,
  v2MePatchSchema,
  v2NotificationPrefsSchema,
} from './v2.auth.schemas.js';

export function createV2MeRouter(): Router {
  const r = Router();
  r.use(requireUser);

  r.get('/', asyncHandler(ctrl.meGet));
  r.patch('/', validate({ body: v2MePatchSchema }), asyncHandler(ctrl.mePatch));
  r.post('/contact-change', validate({ body: v2ContactChangeSchema }), asyncHandler(ctrl.contactChangeStart));
  r.post(
    '/contact-change/verify',
    validate({ body: v2ContactChangeVerifySchema }),
    asyncHandler(ctrl.contactChangeVerify),
  );
  r.put('/business-type', validate({ body: v2BusinessTypeSchema }), asyncHandler(ctrl.businessTypePut));
  r.get('/summary', asyncHandler(ctrl.summaryGet));
  r.get('/notification-preferences', asyncHandler(ctrl.prefsGet));
  r.patch(
    '/notification-preferences',
    validate({ body: v2NotificationPrefsSchema }),
    asyncHandler(ctrl.prefsPatch),
  );

  return r;
}
