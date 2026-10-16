import { Router } from 'express';
import { z } from 'zod';
import { currentUserId } from '../../common/http/actor.js';
import { ah } from '../../common/http/async-handler.js';
import { validate } from '../../common/middleware/validate.js';
import { buildOffsetPage, pageWindow } from '../../common/utils/cursor.js';
import { webMoney } from '../../common/utils/currency.js';
import { iso } from '../../common/utils/time-display.js';
import type { ILetterOfCredit } from '../../models/contract-lc.model.js';
import { requireKyc, requireRole, requireUser } from '../auth/auth.middleware.js';
import { lcsService as svc, requiredDocuments } from './lcs.service.js';

const STATUSES = ['Applied', 'Issued', 'Advised', 'Confirmed', 'Presented', 'Examined', 'Paid', 'Refused', 'Expired'] as const;
const DOC_KEYS = ['invoice', 'bl', 'packing', 'origin', 'assay', 'insurance', 'inspection'] as const;

const createBody = z.object({ contractId: z.string().min(1) });
const docBody = z.object({
  key: z.enum(DOC_KEYS),
  fileId: z.string().min(1),
  extracted: z.record(z.string().max(500)).optional(),
});
const presentBody = z.object({ notes: z.string().max(2000).optional(), acknowledgeDiscrepancies: z.boolean().optional() });
const adviseBody = z.object({ advisingBankId: z.string().max(40).optional() });
const examineBody = z.object({
  decision: z.enum(['accepted', 'refused']),
  discrepancies: z
    .array(z.object({ code: z.string().max(40), documentKey: z.string().max(20).nullable().default(null), message: z.string().max(500), severity: z.enum(['discrepancy', 'warning']).default('discrepancy') }))
    .max(50)
    .optional(),
  notes: z.string().max(2000).optional(),
});
const payBody = z.object({ reference: z.string().max(80).optional() });
const idParam = z.object({ lcId: z.string().min(1) });
const listQuery = z.object({
  status: z.enum(STATUSES).optional(),
  page: z.coerce.number().int().min(1).optional(),
  perPage: z.coerce.number().int().min(1).max(100).optional(),
});

const TIMELINE_LABELS: Record<string, string> = {
  applied: 'LC application submitted',
  issued: 'LC issued by issuing bank',
  advised: 'LC advised to beneficiary',
  confirmed: 'LC confirmed',
  presented: 'Documents presented',
  examined: 'Documents accepted by bank',
  refused: 'Documents refused',
  paid: 'Payment released',
  expired: 'LC expired',
};

export const toWebLc = (lc: ILetterOfCredit, viewerId?: string) => ({
  id: lc._id,
  reference: lc.reference,
  status: lc.status,
  role: viewerId ? (lc.applicantId === viewerId ? 'applicant' : lc.beneficiaryId === viewerId ? 'beneficiary' : 'bank') : 'bank',
  lcType: lc.lcType,
  tenor: lc.tenor,
  amount: webMoney(lc.amount),
  contractId: lc.contractId,
  issuingBank: lc.issuingBank,
  advisingBank: lc.advisingBank ?? null,
  goodsDescription: lc.goodsDescription,
  incoterm: lc.incoterm,
  namedPort: lc.namedPort,
  latestShipmentDate: lc.latestShipmentDate,
  expiresAt: iso(lc.expiresAt),
  presentationPeriodDays: lc.presentationPeriodDays,
  requiredDocuments: requiredDocuments(lc),
  documents: lc.documents.map((d) => ({ key: d.key, fileId: d.fileId, uploadedAt: iso(d.uploadedAt), extracted: d.extracted ?? null })),
  precheck: lc.precheck ? { checkedAt: iso(lc.precheck.checkedAt), compliant: lc.precheck.compliant, discrepancies: lc.precheck.discrepancies } : null,
  presentation: lc.presentation
    ? { presentedAt: iso(lc.presentation.presentedAt), notes: lc.presentation.notes ?? null, examination: lc.presentation.examination ?? null, examinedAt: iso(lc.presentation.examinedAt), discrepancies: lc.presentation.discrepancies, examinerNotes: lc.presentation.examinerNotes ?? null }
    : null,
  payment: lc.payment ? { releasedAt: iso(lc.payment.releasedAt), amount: webMoney(lc.payment.amount), reference: lc.payment.reference ?? null } : null,
  version: lc.version,
  createdAt: iso(lc.createdAt),
  updatedAt: iso(lc.updatedAt),
});

const timeline = (lc: ILetterOfCredit) => lc.milestones.map((m) => ({ key: m.key, label: TIMELINE_LABELS[m.key] ?? m.key, at: iso(m.at) }));

/** Web `/lcs/*` (applicant + beneficiary) and `/bank/lcs/*` (bank portal). */
export function webLcsRouter(): Router {
  const r = Router();
  const id = validate({ params: idParam });

  r.post('/lcs', requireUser, requireKyc, validate({ body: createBody }), ah(async (req, res) => {
    const userId = currentUserId(req);
    res.status(201).json(toWebLc(await svc.create(userId, req.body.contractId), userId));
  }));
  r.get('/lcs', requireUser, validate({ query: listQuery }), ah(async (req, res) => {
    const userId = currentUserId(req);
    const win = pageWindow(req.query as { page?: unknown; perPage?: unknown });
    const { rows, total } = await svc.list(userId, req.query.status as ILetterOfCredit['status'] | undefined, win.skip, win.perPage);
    res.json(buildOffsetPage(rows.map((l) => toWebLc(l, userId)), total, win));
  }));
  r.get('/lcs/:lcId', requireUser, id, ah(async (req, res) => {
    const userId = currentUserId(req);
    res.json(toWebLc(await svc.get(userId, String(req.params.lcId)), userId));
  }));
  r.get('/lcs/:lcId/timeline', requireUser, id, ah(async (req, res) => {
    res.json({ items: timeline(await svc.get(currentUserId(req), String(req.params.lcId))) });
  }));
  // Contract: GET /lcs/{lcId}/milestones
  r.get('/lcs/:lcId/milestones', requireUser, id, ah(async (req, res) => {
    res.json({ items: timeline(await svc.get(currentUserId(req), String(req.params.lcId))) });
  }));
  // Contract: GET /lcs/{lcId}/documents
  r.get('/lcs/:lcId/documents', requireUser, id, ah(async (req, res) => {
    const userId = currentUserId(req);
    const lc = await svc.get(userId, String(req.params.lcId));
    res.json({
      required: requiredDocuments(lc),
      items: lc.documents.map((d) => ({ key: d.key, fileId: d.fileId, uploadedAt: iso(d.uploadedAt), extracted: d.extracted ?? null })),
    });
  }));
  r.post('/lcs/:lcId/documents', requireUser, requireKyc, id, validate({ body: docBody }), ah(async (req, res) => {
    const userId = currentUserId(req);
    res.status(201).json(toWebLc(await svc.addDocument(userId, String(req.params.lcId), req.body), userId));
  }));
  // Contract: DELETE /lcs/{lcId}/documents/{documentKey}
  r.delete('/lcs/:lcId/documents/:documentKey', requireUser, requireKyc, validate({ params: z.object({ lcId: z.string().min(1), documentKey: z.string().min(1) }) }), ah(async (req, res) => {
    const userId = currentUserId(req);
    res.json(toWebLc(await svc.removeDocument(userId, String(req.params.lcId), String(req.params.documentKey)), userId));
  }));
  r.post('/lcs/:lcId/precheck', requireUser, id, ah(async (req, res) => {
    const userId = currentUserId(req);
    res.json(toWebLc(await svc.precheck(userId, String(req.params.lcId)), userId));
  }));
  r.post('/lcs/:lcId/presentation', requireUser, requireKyc, id, validate({ body: presentBody }), ah(async (req, res) => {
    const userId = currentUserId(req);
    res.json(toWebLc(await svc.present(userId, String(req.params.lcId), req.body), userId));
  }));
  // Contract: POST /lcs/{lcId}/amendments
  r.post('/lcs/:lcId/amendments', requireUser, requireKyc, id, validate({ body: z.object({ fields: z.record(z.unknown()), reason: z.string().max(500).optional() }) }), ah(async (req, res) => {
    const userId = currentUserId(req);
    res.status(201).json(toWebLc(await svc.requestAmendment(userId, String(req.params.lcId), req.body), userId));
  }));

  /* bank portal — legacy /bank/lcs/* and contract /bank/lc-applications + /bank/presentations */
  const bank = [requireUser, requireRole('bank_operator')] as const;
  const listBank = ah(async (req: import('express').Request, res: import('express').Response) => {
    const win = pageWindow(req.query as { page?: unknown; perPage?: unknown });
    const { rows, total } = await svc.bank.list(currentUserId(req), req.query.status as ILetterOfCredit['status'] | undefined, win.skip, win.perPage);
    res.json(buildOffsetPage(rows.map((l) => toWebLc(l)), total, win));
  });
  const getBank = ah(async (req: import('express').Request, res: import('express').Response) => {
    res.json(toWebLc(await svc.bank.get(currentUserId(req), String(req.params.lcId))));
  });

  r.get('/bank/lcs', ...bank, validate({ query: listQuery }), listBank);
  r.get('/bank/lc-applications', ...bank, validate({ query: listQuery }), listBank);
  r.get('/bank/lcs/:lcId', ...bank, id, getBank);
  r.get('/bank/lc-applications/:lcId', ...bank, id, getBank);
  r.post('/bank/lcs/:lcId/issue', ...bank, id, ah(async (req, res) => {
    res.json(toWebLc(await svc.bank.issue(currentUserId(req), String(req.params.lcId))));
  }));
  r.post('/bank/lc-applications/:lcId/issue', ...bank, id, ah(async (req, res) => {
    res.json(toWebLc(await svc.bank.issue(currentUserId(req), String(req.params.lcId))));
  }));
  r.post('/bank/lcs/:lcId/advise', ...bank, id, validate({ body: adviseBody }), ah(async (req, res) => {
    res.json(toWebLc(await svc.bank.advise(currentUserId(req), String(req.params.lcId), req.body.advisingBankId)));
  }));
  r.post('/bank/lc-applications/:lcId/advise', ...bank, id, validate({ body: adviseBody }), ah(async (req, res) => {
    res.json(toWebLc(await svc.bank.advise(currentUserId(req), String(req.params.lcId), req.body.advisingBankId)));
  }));
  r.post('/bank/lcs/:lcId/confirm', ...bank, id, ah(async (req, res) => {
    res.json(toWebLc(await svc.bank.confirm(currentUserId(req), String(req.params.lcId))));
  }));
  r.post('/bank/lc-applications/:lcId/confirm', ...bank, id, ah(async (req, res) => {
    res.json(toWebLc(await svc.bank.confirm(currentUserId(req), String(req.params.lcId))));
  }));
  r.post('/bank/lc-applications/:lcId/amend', ...bank, id, validate({ body: z.object({ fields: z.record(z.unknown()), note: z.string().max(500).optional() }) }), ah(async (req, res) => {
    res.status(201).json(toWebLc(await svc.bank.amend(currentUserId(req), String(req.params.lcId), { fields: req.body.fields, reason: req.body.note })));
  }));
  r.get('/bank/presentations/:lcId', ...bank, id, ah(async (req, res) => {
    const lc = await svc.bank.get(currentUserId(req), String(req.params.lcId));
    res.json({
      lcId: lc._id,
      status: lc.status,
      presentation: lc.presentation
        ? { presentedAt: iso(lc.presentation.presentedAt), notes: lc.presentation.notes ?? null, examination: lc.presentation.examination ?? null, discrepancies: lc.presentation.discrepancies }
        : null,
      documents: lc.documents,
      precheck: lc.precheck ?? null,
    });
  }));
  r.post('/bank/lcs/:lcId/examination', ...bank, id, validate({ body: examineBody }), ah(async (req, res) => {
    res.json(toWebLc(await svc.bank.examine(currentUserId(req), String(req.params.lcId), req.body)));
  }));
  r.post('/bank/presentations/:lcId/examination', ...bank, id, validate({ body: examineBody }), ah(async (req, res) => {
    res.json(toWebLc(await svc.bank.examine(currentUserId(req), String(req.params.lcId), req.body)));
  }));
  r.post('/bank/lcs/:lcId/payment', ...bank, id, validate({ body: payBody }), ah(async (req, res) => {
    res.json(toWebLc(await svc.bank.pay(currentUserId(req), String(req.params.lcId), req.body.reference)));
  }));
  r.post('/bank/presentations/:lcId/payment', ...bank, id, validate({ body: payBody }), ah(async (req, res) => {
    res.json(toWebLc(await svc.bank.pay(currentUserId(req), String(req.params.lcId), req.body.reference)));
  }));

  return r;
}
