import { Router } from 'express';
import { validate } from '../../common/middleware/validate.js';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireUser } from '../auth/auth.middleware.js';
import { webCaptureBody, webPatchKycBody, webSelfieBody, webSideParams } from './kyc.schemas.js';
import * as ctrl from './web.kyc.controller.js';

/** Web KYC, relative to `/v1`. Needs a session but is *not* KYC-gated. */
export function createWebKycRouter(): Router {
  const r = Router();
  r.get('/kyc', requireUser, asyncHandler(ctrl.getKyc));
  r.patch('/kyc', requireUser, validate({ body: webPatchKycBody }), asyncHandler(ctrl.patchKyc));
  r.post('/kyc/captures', requireUser, validate({ body: webCaptureBody }), asyncHandler(ctrl.postCapture));
  r.delete(
    '/kyc/captures/:side',
    requireUser,
    validate({ params: webSideParams }),
    asyncHandler(ctrl.deleteCapture),
  );
  r.post('/kyc/selfie', requireUser, validate({ body: webSelfieBody }), asyncHandler(ctrl.postSelfie));
  r.post('/kyc/submit', requireUser, asyncHandler(ctrl.postSubmit));
  return r;
}
