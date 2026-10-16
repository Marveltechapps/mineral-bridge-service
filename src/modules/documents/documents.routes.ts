import { Router } from 'express';
import { z } from 'zod';
import { currentUserId } from '../../common/http/actor.js';
import { ah } from '../../common/http/async-handler.js';
import { validate } from '../../common/middleware/validate.js';
import { buildCursorPage, buildOffsetPage, cursorWindow, pageWindow } from '../../common/utils/cursor.js';
import { iso } from '../../common/utils/time-display.js';
import type { IUserDocument } from '../../models/document.model.js';
import { requireUser } from '../auth/auth.middleware.js';
import { uploadsService } from '../uploads/uploads.service.js';
import { DOC_KINDS, documentsService as svc } from './documents.service.js';

const idParam = z.object({ documentId: z.string().min(1) });
const createBody = z.object({
  name: z.string().min(1).max(160),
  kind: z.enum(DOC_KINDS),
  fileId: z.string().min(1),
  issuedAt: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  expiresAt: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
});
const patchBody = z.object({ name: z.string().min(1).max(160).optional(), expiresAt: z.string().nullable().optional() });
const mobileList = z.object({ kind: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).optional(), cursor: z.string().optional() });
const webList = z.object({ kind: z.string().optional(), page: z.coerce.number().int().min(1).optional(), perPage: z.coerce.number().int().min(1).max(100).optional() });

const mobileDoc = (d: IUserDocument) => ({
  id: d._id,
  name: d.name,
  kind: d.kind,
  status: d.status,
  contentType: d.contentType ?? null,
  bytes: d.bytes ?? null,
  issuedAt: iso(d.issuedAt),
  expiresAt: iso(d.expiresAt),
  reviewerNotes: d.status === 'rejected' ? (d.reviewerNotes ?? null) : null,
  downloadUrl: d.fileId ? uploadsService.signed(d.fileId).url : null,
  uploadedAt: iso(d.createdAt),
});

const webDoc = (d: IUserDocument) => ({
  id: d._id,
  name: d.name,
  type: d.kind,
  status: d.status,
  mimeType: d.contentType ?? null,
  sizeBytes: d.bytes ?? null,
  issuedAt: iso(d.issuedAt),
  expiresAt: iso(d.expiresAt),
  rejectionReason: d.status === 'rejected' ? (d.reviewerNotes ?? null) : null,
  file: d.fileId ? (({ url, expiresAt }) => ({ url, expiresAt: iso(expiresAt) }))(uploadsService.signed(d.fileId)) : null,
  uploadedAt: iso(d.createdAt),
});

/** Mobile /documents. */
export function mobileDocumentsRouter(): Router {
  const r = Router();
  const id = validate({ params: idParam });
  r.get('/documents', requireUser, validate({ query: mobileList }), ah(async (req, res) => {
    const win = cursorWindow(req.query as { limit?: unknown; cursor?: unknown });
    const { rows, total } = await svc.list(currentUserId(req), win.skip, win.limit, req.query.kind as string | undefined);
    res.json(buildCursorPage(rows.map(mobileDoc), total, win));
  }));
  r.post('/documents', requireUser, validate({ body: createBody }), ah(async (req, res) => res.status(201).json(mobileDoc(await svc.create(currentUserId(req), req.body)))));
  r.get('/documents/:documentId', requireUser, id, ah(async (req, res) => res.json(mobileDoc(await svc.get(currentUserId(req), String(req.params.documentId))))));
  r.patch('/documents/:documentId', requireUser, id, validate({ body: patchBody }), ah(async (req, res) => res.json(mobileDoc(await svc.update(currentUserId(req), String(req.params.documentId), req.body)))));
  // Contract path: PUT /documents/{documentId} (replace document)
  r.put('/documents/:documentId', requireUser, id, validate({ body: createBody.partial().extend({ fileId: z.string().min(1).optional(), name: z.string().min(1).max(160).optional() }) }), ah(async (req, res) => {
    res.json(mobileDoc(await svc.replace(currentUserId(req), String(req.params.documentId), req.body)));
  }));
  r.delete('/documents/:documentId', requireUser, id, ah(async (req, res) => { await svc.remove(currentUserId(req), String(req.params.documentId)); res.status(204).end(); }));
  return r;
}

/** Web /account/documents (same collection, web shape). */
export function webDocumentsRouter(): Router {
  const r = Router();
  const id = validate({ params: idParam });
  r.get('/account/documents', requireUser, validate({ query: webList }), ah(async (req, res) => {
    const win = pageWindow(req.query as { page?: unknown; perPage?: unknown });
    const { rows, total } = await svc.list(currentUserId(req), win.skip, win.perPage, req.query.kind as string | undefined);
    res.json(buildOffsetPage(rows.map(webDoc), total, win));
  }));
  r.post('/account/documents', requireUser, validate({ body: createBody }), ah(async (req, res) => res.status(201).json(webDoc(await svc.create(currentUserId(req), req.body)))));
  r.get('/account/documents/:documentId', requireUser, id, ah(async (req, res) => res.json(webDoc(await svc.get(currentUserId(req), String(req.params.documentId))))));
  r.delete('/account/documents/:documentId', requireUser, id, ah(async (req, res) => { await svc.remove(currentUserId(req), String(req.params.documentId)); res.status(204).end(); }));
  return r;
}
