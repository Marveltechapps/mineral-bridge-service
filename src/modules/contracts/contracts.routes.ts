import { Router } from 'express';
import { z } from 'zod';
import { currentUserId } from '../../common/http/actor.js';
import { ah } from '../../common/http/async-handler.js';
import { validate } from '../../common/middleware/validate.js';
import { buildOffsetPage, pageWindow } from '../../common/utils/cursor.js';
import { webMoney } from '../../common/utils/currency.js';
import { iso } from '../../common/utils/time-display.js';
import type { IContract } from '../../models/contract-lc.model.js';
import { requireKyc, requireUser } from '../auth/auth.middleware.js';
import { contractsService as svc } from './contracts.service.js';

const lcType = z.enum(['Irrevocable', 'Confirmed', 'Standby']);
const tenor = z.enum(['At sight', '30 days', '60 days', '90 days']);
const createBody = z.object({
  negotiationId: z.string().min(1),
  lcType: lcType.default('Irrevocable'),
  tenor: tenor.default('At sight'),
  issuingBankId: z.string().min(1).max(40),
  presentationPeriodDays: z.number().int().min(1).max(45).default(21),
});
const patchBody = z.object({
  lcType: lcType.optional(),
  tenor: tenor.optional(),
  issuingBankId: z.string().min(1).max(40).optional(),
  presentationPeriodDays: z.number().int().min(1).max(45).optional(),
});
const signBody = z.object({ signatory: z.string().trim().min(2).max(120) });
const idParam = z.object({ contractId: z.string().min(1) });
const listQuery = z.object({
  status: z.enum(['draft', 'signed', 'countersigned', 'cancelled']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  perPage: z.coerce.number().int().min(1).max(100).optional(),
});

export const toWebContract = (c: IContract, viewerId: string) => ({
  id: c._id,
  reference: c.reference,
  status: c.status,
  role: c.buyerId === viewerId ? 'buyer' : 'seller',
  negotiationId: c.negotiationId,
  lcId: c.lcId ?? null,
  terms: { ...c.terms, unitPrice: webMoney(c.terms.unitPrice), total: webMoney(c.terms.total) },
  signatures: {
    buyer: c.signatures.buyer ? { signatory: c.signatures.buyer.signatory, signedAt: iso(c.signatures.buyer.signedAt) } : null,
    seller: c.signatures.seller ? { signatory: c.signatures.seller.signatory, signedAt: iso(c.signatures.seller.signedAt) } : null,
  },
  termsHash: c.termsHash ?? null,
  anchor: c.anchor ? { ...c.anchor, anchoredAt: iso(c.anchor.anchoredAt) } : null,
  version: c.version,
  createdAt: iso(c.createdAt),
  updatedAt: iso(c.updatedAt),
});

/** Web `/contracts/*`. */
export function webContractsRouter(): Router {
  const r = Router();
  const id = validate({ params: idParam });

  r.post('/contracts', requireUser, requireKyc, validate({ body: createBody }), ah(async (req, res) => {
    const userId = currentUserId(req);
    const { negotiationId, ...terms } = req.body;
    res.status(201).json(toWebContract(await svc.create(userId, negotiationId, terms), userId));
  }));
  r.get('/contracts', requireUser, validate({ query: listQuery }), ah(async (req, res) => {
    const userId = currentUserId(req);
    const win = pageWindow(req.query as { page?: unknown; perPage?: unknown });
    const { rows, total } = await svc.list(userId, req.query.status as IContract['status'] | undefined, win.skip, win.perPage);
    res.json(buildOffsetPage(rows.map((c) => toWebContract(c, userId)), total, win));
  }));
  r.get('/contracts/:contractId', requireUser, id, ah(async (req, res) => {
    const userId = currentUserId(req);
    res.json(toWebContract(await svc.get(userId, String(req.params.contractId)), userId));
  }));
  r.patch('/contracts/:contractId', requireUser, requireKyc, id, validate({ body: patchBody }), ah(async (req, res) => {
    const userId = currentUserId(req);
    res.json(toWebContract(await svc.patch(userId, String(req.params.contractId), req.body), userId));
  }));
  r.post('/contracts/:contractId/sign', requireUser, requireKyc, id, validate({ body: signBody }), ah(async (req, res) => {
    const userId = currentUserId(req);
    res.json(toWebContract(await svc.sign(userId, String(req.params.contractId), req.body.signatory), userId));
  }));
  r.delete('/contracts/:contractId', requireUser, id, ah(async (req, res) => {
    const userId = currentUserId(req);
    res.json(toWebContract(await svc.cancel(userId, String(req.params.contractId)), userId));
  }));
  r.get('/contracts/:contractId/document', requireUser, id, ah(async (req, res) => {
    const s = await svc.document(currentUserId(req), String(req.params.contractId));
    res.json({ url: s.url, expiresAt: iso(s.expiresAt), expiresIn: s.expiresIn, contentType: 'application/pdf' });
  }));

  return r;
}
