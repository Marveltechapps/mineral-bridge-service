import { Router } from 'express';
import { validate } from '../../common/middleware/validate.js';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireUser } from '../auth/auth.middleware.js';
import { mobileSubmissionBody, submissionIdParams } from './kyc.schemas.js';
import * as ctrl from './mobile.kyc.controller.js';

/** Mobile KYC (#22–#27), relative to `/v1`. Needs a session but is *not* KYC-gated. */
export function createMobileKycRouter(): Router {
  const r = Router();
  r.get('/kyc/status', requireUser, asyncHandler(ctrl.getStatus));
  r.get('/kyc/id-types', requireUser, ctrl.getIdTypes);
  r.post('/kyc/documents', requireUser, ctrl.kycUploadMiddleware, asyncHandler(ctrl.postDocument));
  r.post(
    '/kyc/submissions',
    requireUser,
    validate({ body: mobileSubmissionBody }),
    asyncHandler(ctrl.postSubmission),
  );
  r.get(
    '/kyc/submissions/:submissionId',
    requireUser,
    validate({ params: submissionIdParams }),
    asyncHandler(ctrl.getSubmission),
  );
  r.post('/kyc/notify-me', requireUser, asyncHandler(ctrl.notifyMe));
  return r;
}
