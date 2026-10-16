import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import { AppError, notFound, unprocessable } from '../../common/errors/app-error.js';
import { clientIp } from '../auth/auth.http.js';
import { getUserContext } from '../auth/auth.middleware.js';
import { KYC_ID_TYPES } from './kyc.id-types.js';
import {
  KYC_MAX_UPLOAD_BYTES,
  getKycFileStore,
  validateKycUpload,
} from './kyc.file-store.js';
import {
  toMobileIdType,
  toMobileKycDocument,
  toMobileKycStatus,
  unreadableHint,
} from './kyc.mappers.js';
import {
  addDocument,
  getLatestSubmission,
  getSubmissionForUser,
  setNotifyOnDecision,
  submitMobile,
} from './kyc.service.js';
import { KYC_MOBILE_CLEARANCE_HOURS } from './kyc.types.js';
import { mobileDocumentFields, mobileSubmissionBody } from './kyc.schemas.js';
import type { z } from 'zod';

// ---- multipart ------------------------------------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: KYC_MAX_UPLOAD_BYTES, files: 1, fields: 8 },
}).single('file');

/** Turns multer's own errors into the contract's `422 document/*` codes. */
export const kycUploadMiddleware: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  upload(req, res, (err: unknown) => {
    if (!err) return next();
    const code = (err as { code?: string }).code;
    if (code === 'LIMIT_FILE_SIZE') {
      return next(
        unprocessable('File is larger than 10 MB.', { file: 'Maximum size is 10 MB' }, 'document/too-large'),
      );
    }
    if (code === 'LIMIT_UNEXPECTED_FILE' || code === 'LIMIT_FILE_COUNT') {
      return next(unprocessable('Send exactly one file in the `file` field.', { file: 'Expected one file' }));
    }
    next(err);
  });
};

// ---- handlers -------------------------------------------------------------------------------

// #22
export async function getStatus(req: Request, res: Response): Promise<void> {
  const { user } = getUserContext(req);
  const latest = await getLatestSubmission(user.id);
  res.status(200).json(toMobileKycStatus(user, latest));
}

// #23
export function getIdTypes(_req: Request, res: Response): void {
  res.status(200).json({ data: KYC_ID_TYPES.map(toMobileIdType) });
}

// #24
export async function postDocument(req: Request, res: Response): Promise<void> {
  const { user } = getUserContext(req);
  const fields: z.infer<typeof mobileDocumentFields> = mobileDocumentFields.parse(req.body ?? {});
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) throw unprocessable('Attach the photo in the `file` field.', { file: 'Required' });

  const mime = validateKycUpload(fields.kind, file.buffer);
  const stored = await getKycFileStore().save({ userId: user.id, buffer: file.buffer, mimeType: mime });

  const { document, kept } = await addDocument({
    userId: user.id,
    kind: fields.kind,
    idTypeId: fields.idTypeId,
    fileId: stored.fileId,
    mimeType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    originalName: file.originalname,
    buffer: file.buffer,
    source: 'mobile',
    rejectUnreadable: true,
  });

  if (!kept) {
    if (fields.kind === 'selfie') {
      throw unprocessable(
        'We could not match your selfie. Retake it facing the camera.',
        undefined,
        'kyc/selfie-mismatch',
      );
    }
    throw new AppError({
      status: 422,
      code: 'kyc/document-unreadable',
      message: 'We could not read that document.',
      hint: unreadableHint(document.quality.issues),
    });
  }
  res.status(201).json(toMobileKycDocument(document));
}

// #25
export async function postSubmission(req: Request, res: Response): Promise<void> {
  const { user } = getUserContext(req);
  const body = req.body as z.infer<typeof mobileSubmissionBody>;
  const submission = await submitMobile({
    userId: user.id,
    idTypeId: body.idTypeId,
    idNumber: body.idNumber,
    documentIds: body.documentIds,
    tierId: body.tierId,
    declaredDetails: body.declaredDetails,
    consent: body.consent,
    ip: clientIp(req),
  });
  res.status(202).json({
    id: submission.publicId,
    reference: submission.reference,
    status: 'pending',
    estimatedClearanceHours: KYC_MOBILE_CLEARANCE_HOURS,
  });
}

// #26
export async function getSubmission(req: Request, res: Response): Promise<void> {
  const { user } = getUserContext(req);
  const { submissionId } = req.params as { submissionId: string };
  const submission = await getSubmissionForUser(user.id, submissionId);
  if (!submission) throw notFound('resource/not-found', 'KYC submission not found');
  // Scoped to one submission: its own state, not the account's current projection.
  const status =
    submission.status === 'verified'
      ? 'verified'
      : submission.status === 'rejected' || submission.status === 'resubmission_required'
        ? 'rejected'
        : 'pending';
  res.status(200).json(toMobileKycStatus({ ...user, kycStatus: status }, submission));
}

// #27
export async function notifyMe(req: Request, res: Response): Promise<void> {
  const { user } = getUserContext(req);
  await setNotifyOnDecision(user.id);
  res.status(204).end();
}
