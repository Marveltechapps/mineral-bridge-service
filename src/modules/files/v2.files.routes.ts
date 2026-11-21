import type { Request, RequestHandler, Response } from 'express';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { AppError, conflict, forbidden, unprocessable } from '../../common/errors/app-error.js';
import { validate } from '../../common/middleware/validate.js';
import { createSignedUrl } from '../../common/storage/signed-url.js';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { FileModel } from '../../models/file.model.js';
import { getUserContext, requireUser } from '../auth/auth.middleware.js';
import {
  MAX_UPLOAD_BYTES,
  normalizeUploadPurpose,
  uploadsService,
} from '../uploads/uploads.service.js';

const PURPOSE = z.enum([
  'kyc',
  'sell_photo',
  'sell_document',
  'payment_proof',
  'refund_evidence',
  'delivery_photo',
  'support_attachment',
  'avatar',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 8 },
}).single('file');

const uploadMiddleware: RequestHandler = (req, _res, next) => {
  upload(req, _res, (err: unknown) => {
    if (!err) return next();
    const code = (err as { code?: string }).code;
    if (code === 'LIMIT_FILE_SIZE') {
      return next(new AppError({ status: 413, code: 'file/too-large', message: 'File exceeds the size limit.' }));
    }
    next(err);
  });
};

export function createV2FilesRouter(): Router {
  const r = Router();
  r.use(requireUser);

  r.post(
    '/',
    uploadMiddleware,
    asyncHandler(async (req: Request, res: Response) => {
      const { user } = getUserContext(req);
      const purposeRaw = String((req.body as { purpose?: string })?.purpose ?? '');
      const parsed = PURPOSE.safeParse(purposeRaw);
      if (!parsed.success) {
        throw unprocessable('Invalid upload purpose.', { purpose: 'Invalid' }, 'file/purpose-invalid');
      }
      const purpose = normalizeUploadPurpose(parsed.data) ?? parsed.data;
      const file = req.file;
      if (!file) throw unprocessable('Send a file in the `file` field.', { file: 'Required' });

      const contentType = (file.mimetype || 'application/octet-stream').split(';')[0]!;
      const target = await uploadsService.createTarget(user.id, {
        purpose,
        filename: file.originalname || 'upload.bin',
        contentType,
        bytes: file.size,
      });
      const received = await uploadsService.receive(target.file._id, file.buffer, contentType);
      await FileModel.updateOne(
        { _id: received._id },
        {
          $set: {
            owner: { type: 'user', id: user.id },
            scan: { status: 'clean', at: new Date() },
            uploadedBy: { kind: 'user', id: user.id },
          },
        },
      );

      res.status(201).json({
        fileId: received._id,
        name: received.filename,
        contentType: received.contentType,
        bytes: received.bytes,
        scan: 'clean',
      });
    }),
  );

  r.get(
    '/:fileId/url',
    validate({ params: z.object({ fileId: z.string().min(3) }) }),
    asyncHandler(async (req: Request, res: Response) => {
      const { user } = getUserContext(req);
      const fileId = String(req.params.fileId);
      const f = await FileModel.findOne({ _id: fileId, deletedAt: null }).lean();
      if (!f || f.ownerId !== user.id) throw forbidden('file/not-found', 'File not found');
      if (f.bytes === 0) throw conflict('file/scan-pending', 'File upload is incomplete.');
      if (f.scan?.status === 'pending') throw conflict('file/scan-pending', 'File is still being scanned.');
      if (f.scan?.status === 'infected') throw forbidden('file/infected', 'File failed security scan.');
      const ttl = f.purpose === 'kyc' ? 120 : 900;
      const signed = createSignedUrl('file', fileId, ttl);
      res.status(200).json({
        url: signed.url,
        expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      });
    }),
  );

  return r;
}
