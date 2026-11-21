import express, { Router } from 'express';
import { currentUserId } from '../../common/http/actor.js';
import { ah } from '../../common/http/async-handler.js';
import { forbidden } from '../../common/errors/app-error.js';
import { validate } from '../../common/middleware/validate.js';
import { verifySignedUrl } from '../../common/storage/signed-url.js';
import { iso } from '../../common/utils/time-display.js';
import { z } from 'zod';
import { requireUser } from '../auth/auth.middleware.js';
import { MAX_UPLOAD_BYTES, UPLOAD_PURPOSES, uploadsService as svc } from './uploads.service.js';

const createBody = z.object({
  purpose: z.enum(UPLOAD_PURPOSES).default('general'),
  filename: z.string().min(1).max(200),
  contentType: z.string().min(3).max(100),
  bytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  refType: z.string().max(40).optional(),
  refId: z.string().max(80).optional(),
});

/** Web POST /uploads: register a file and get a one-shot upload URL. */
export function webUploadsRouter(): Router {
  const r = Router();
  r.post('/uploads', requireUser, validate({ body: createBody }), ah(async (req, res) => {
    const out = await svc.createTarget(currentUserId(req), req.body);
    res.status(201).json({ fileId: out.file._id, upload: out.upload, expiresIn: 900 });
  }));
  // Contract: GET /files/{fileId} — signed, time-limited read URL
  r.get('/files/:fileId', requireUser, ah(async (req, res) => {
    const fileId = String(req.params.fileId);
    await svc.owned(currentUserId(req), fileId);
    const signed = svc.signed(fileId);
    res.json({ fileId, url: signed.url, expiresAt: iso(signed.expiresAt), expiresIn: 900 });
  }));
  return r;
}

/** Client-agnostic byte transfer: signed PUT (upload) and signed GET (download). No bearer token; the signature is the credential. */
export function filesRouter(): Router {
  const r = Router();

  r.put('/files/upload/:fileId', express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), ah(async (req, res) => {
    const fileId = String(req.params.fileId);
    if (!verifySignedUrl('file', fileId, Number(req.query.exp), String(req.query.sig ?? ''))) throw forbidden('auth/forbidden', 'This upload link is invalid or has expired');
    const f = await svc.receive(fileId, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), req.header('content-type'));
    res.status(200).json({ fileId: f._id, bytes: f.bytes, checksum: f.checksum ?? null, uploadedAt: iso(new Date()) });
  }));

  r.get('/files/signed/:kind/:id', ah(async (req, res) => {
    const kind = String(req.params.kind);
    const id = String(req.params.id);
    if (!verifySignedUrl(kind, id, Number(req.query.exp), String(req.query.sig ?? ''))) throw forbidden('auth/forbidden', 'This link is invalid or has expired');
    if (kind === 'file') {
      const { file, stream } = await svc.openForDownload(id);
      res.setHeader('Content-Type', file.contentType);
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.filename)}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      return;
    }
    // Generated artefacts (contract/LC/order documents) are rendered as a minimal PDF stub.
    const body = `%PDF-1.4\n% Mineral Bridge ${kind} ${id}\n%%EOF\n`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(Buffer.from(body));
  }));

  return r;
}
