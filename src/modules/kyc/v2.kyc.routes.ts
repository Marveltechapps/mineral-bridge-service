import { Router } from 'express';
import { z } from 'zod';
import { conflict, unprocessable } from '../../common/errors/app-error.js';
import { validate } from '../../common/middleware/validate.js';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { clientIp } from '../auth/auth.http.js';
import { getUserContext, requireUser } from '../auth/auth.middleware.js';
import { enqueueOutbox } from '../outbox/outbox.service.js';
import { getIdType } from './kyc.id-types.js';
import {
  addDocument,
  getKycView,
  removeDocumentKind,
  setDraftIdType,
  submitWeb,
  type KycView,
} from './kyc.service.js';
import type { KycDocKind } from './kyc.types.js';
import { KYC_WEB_REVIEW_SLA_HOURS } from './kyc.types.js';

const wireIdType = z.enum(['national_id', 'passport', 'driving_licence', 'voter_card']);
const wireKind = z.enum([
  'id_front',
  'id_back',
  'selfie',
  'proof_of_address',
  'business_registration',
]);

function toInternalIdType(wire: z.infer<typeof wireIdType>): string {
  switch (wire) {
    case 'national_id':
      return 'nin';
    case 'passport':
      return 'passport';
    case 'driving_licence':
      return 'drivers_licence';
    case 'voter_card':
      return 'voters_card';
  }
}

function toWireIdType(id: string | undefined): string | null {
  switch (id) {
    case 'nin':
      return 'national_id';
    case 'passport':
      return 'passport';
    case 'drivers_licence':
      return 'driving_licence';
    case 'voters_card':
      return 'voter_card';
    default:
      return null;
  }
}

function requiredKinds(view: KycView): KycDocKind[] {
  const idType = getIdType(view.active?.idTypeId);
  const kinds: KycDocKind[] = ['id_front', 'selfie', 'proof_of_address'];
  if (idType?.requiresBack) kinds.splice(1, 0, 'id_back');
  const isBusiness = Boolean(view.user.business?.name || view.user.profile.companyName);
  if (isBusiness) kinds.push('business_registration');
  return kinds;
}

function toV2KycBody(view: KycView) {
  const active = view.active;
  const status =
    active?.status ??
    (view.user.kycStatus === 'none' ? 'none' : view.user.kycStatus === 'pending' ? 'pending' : view.user.kycStatus);
  return {
    status,
    reference: active?.reference ?? view.user.kycReference ?? null,
    idType: toWireIdType(active?.idTypeId),
    requiredKinds: requiredKinds(view),
    documents: view.documents.map((d) => ({
      kind: d.kind,
      fileId: d.fileId,
      name: d.originalName ?? d.kind,
      size: d.sizeBytes ?? 0,
      uploadedAt: d.uploadedAt.toISOString(),
      status: d.review?.status === 'verified' ? 'verified' : d.review?.status === 'rejected' ? 'rejected' : 'uploaded',
      flag: d.flag
        ? { message: d.flag.message, at: d.flag.at.toISOString() }
        : undefined,
    })),
    consent: Boolean(active?.consent?.given),
    submittedAt: active?.submittedAt?.toISOString() ?? null,
    slaDueAt: active?.estimatedDecisionBy?.toISOString() ?? null,
    rejection: active?.rejection
      ? { reason: active.rejection.reason, retryAllowed: active.rejection.retryAllowed }
      : null,
  };
}

export function createV2KycRouter(): Router {
  const r = Router();
  r.use(requireUser);

  r.get(
    '/',
    asyncHandler(async (req, res) => {
      const { user } = getUserContext(req);
      res.status(200).json(toV2KycBody(await getKycView(user.id)));
    }),
  );

  r.patch(
    '/',
    validate({
      body: z.object({
        idType: wireIdType.optional(),
        consent: z.boolean().optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const { user } = getUserContext(req);
      const body = req.body as { idType?: z.infer<typeof wireIdType>; consent?: boolean };
      if (body.idType) {
        await setDraftIdType(user.id, toInternalIdType(body.idType), req.apiClient === 'mobile' ? 'mobile' : 'web');
      }
      // Consent is persisted on submit; draft flag accepted here for UX.
      if (body.consent === true) {
        const view = await getKycView(user.id);
        if (view.draft) {
          const { KycSubmissionModel } = await import('./kyc.model.js');
          await KycSubmissionModel.updateOne(
            { _id: view.draft.id, status: 'draft' },
            { $set: { 'consent.given': true, 'consent.at': new Date() } },
          );
        }
      }
      res.status(200).json(toV2KycBody(await getKycView(user.id)));
    }),
  );

  r.put(
    '/documents/:kind',
    validate({
      params: z.object({ kind: wireKind }),
      body: z.object({ fileId: z.string().min(3) }),
    }),
    asyncHandler(async (req, res) => {
      const { user } = getUserContext(req);
      const kind = req.params.kind as KycDocKind;
      const { fileId } = req.body as { fileId: string };
      const view = await getKycView(user.id);
      const required = requiredKinds(view);
      if (!required.includes(kind)) {
        throw unprocessable('This document kind is not required.', { kind }, 'kyc/kind-not-required');
      }
      const idType = getIdType(view.active?.idTypeId);
      if (kind === 'id_back' && idType && !idType.requiresBack) {
        throw unprocessable('Back side not required for this ID type.', { kind }, 'kyc/kind-not-required');
      }
      const { document } = await addDocument({
        userId: user.id,
        kind,
        fileId,
        source: req.apiClient === 'mobile' ? 'mobile' : 'web',
        rejectUnreadable: false,
      });
      res.status(200).json({
        kind: document.kind,
        status: 'uploaded',
        quality: document.quality,
      });
    }),
  );

  r.delete(
    '/documents/:kind',
    validate({ params: z.object({ kind: wireKind }) }),
    asyncHandler(async (req, res) => {
      const { user } = getUserContext(req);
      await removeDocumentKind(user.id, req.params.kind as KycDocKind);
      res.status(204).send();
    }),
  );

  r.post(
    '/submit',
    validate({ body: z.object({ consent: z.literal(true) }) }),
    asyncHandler(async (req, res) => {
      const { user } = getUserContext(req);
      if (user.accountStatus !== 'active') {
        throw conflict('account/suspended', 'Account must be active to submit KYC.');
      }
      const submission = await submitWeb({ userId: user.id, ip: clientIp(req) });
      void enqueueOutbox('kyc.submitted', {
        userId: user.id,
        reference: submission.reference,
        submissionId: submission.id,
      });
      const sla =
        submission.estimatedDecisionBy ??
        new Date(submission.submittedAt!.getTime() + KYC_WEB_REVIEW_SLA_HOURS * 3_600_000);
      res.status(202).json({
        reference: submission.reference,
        status: 'pending',
        slaDueAt: sla.toISOString(),
      });
    }),
  );

  return r;
}
