import type { Request, Response } from 'express';
import { unprocessable } from '../../common/errors/app-error.js';
import { clientIp } from '../auth/auth.http.js';
import { getUserContext } from '../auth/auth.middleware.js';
import { idTypeFromWeb, requiredWebSides, getIdType, type WebSide } from './kyc.id-types.js';
import { toWebCaptureResponse, toWebKycRecord, toWebSelfieResponse } from './kyc.mappers.js';
import {
  addDocument,
  getKycView,
  kindForWebSide,
  removeCapture,
  setDraftIdType,
  submitWeb,
} from './kyc.service.js';
import { KYC_WEB_REVIEW_SLA_HOURS } from './kyc.types.js';

// GET /kyc
export async function getKyc(req: Request, res: Response): Promise<void> {
  const { user } = getUserContext(req);
  res.status(200).json(toWebKycRecord(await getKycView(user.id)));
}

// PATCH /kyc — changing the type discards existing captures
export async function patchKyc(req: Request, res: Response): Promise<void> {
  const { user } = getUserContext(req);
  const { idType: webId } = req.body as { idType: 'national' | 'passport' | 'licence' };
  const idType = idTypeFromWeb(webId);
  if (!idType) throw unprocessable('Unknown ID type.', { idType: 'Choose a supported ID type' });
  await setDraftIdType(user.id, idType.id, 'web');
  res.status(200).json(toWebKycRecord(await getKycView(user.id)));
}

// POST /kyc/captures
export async function postCapture(req: Request, res: Response): Promise<void> {
  const { user } = getUserContext(req);
  const { side, fileId } = req.body as { side: WebSide; fileId: string };

  const view = await getKycView(user.id);
  const idType = getIdType(view.active?.idTypeId);
  if (!idType) throw unprocessable('Choose a document type first.', { side: 'Choose a document type first' });
  if (!requiredWebSides(idType).includes(side)) {
    throw unprocessable(`A ${idType.shortLabel} does not need the ${side} side.`, {
      side: `Expected ${requiredWebSides(idType).join(' and ')}`,
    });
  }

  const { document } = await addDocument({
    userId: user.id,
    kind: kindForWebSide(side),
    fileId,
    source: 'web',
    rejectUnreadable: false,
  });
  res.status(201).json(toWebCaptureResponse(document, idType));
}

// DELETE /kyc/captures/{side}
export async function deleteCapture(req: Request, res: Response): Promise<void> {
  const { user } = getUserContext(req);
  const { side } = req.params as { side: WebSide };
  await removeCapture(user.id, side);
  res.status(204).end();
}

// POST /kyc/selfie — a failed liveness is a 201 with `passed:false`, re-postable without a reset
export async function postSelfie(req: Request, res: Response): Promise<void> {
  const { user } = getUserContext(req);
  const { fileId, livenessToken } = req.body as { fileId: string; livenessToken?: string };
  const { document } = await addDocument({
    userId: user.id,
    kind: 'selfie',
    fileId,
    livenessToken,
    source: 'web',
    rejectUnreadable: false,
  });
  res.status(201).json(toWebSelfieResponse(document));
}

// POST /kyc/submit
export async function postSubmit(req: Request, res: Response): Promise<void> {
  const { user } = getUserContext(req);
  const submission = await submitWeb({ userId: user.id, ip: clientIp(req) });
  res.status(202).json({
    status: 'pending',
    submittedAt: submission.submittedAt!.toISOString(),
    reference: submission.reference,
    estimatedDecisionBy: (
      submission.estimatedDecisionBy ??
      new Date(submission.submittedAt!.getTime() + KYC_WEB_REVIEW_SLA_HOURS * 3_600_000)
    ).toISOString(),
  });
}
