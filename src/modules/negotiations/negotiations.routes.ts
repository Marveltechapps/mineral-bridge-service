import { Router } from 'express';
import { z } from 'zod';
import { currentUserId } from '../../common/http/actor.js';
import { ah } from '../../common/http/async-handler.js';
import { idempotencyKey, requireKeyOrThrow } from '../../common/middleware/idempotency-key.js';
import { validate } from '../../common/middleware/validate.js';
import { buildOffsetPage, pageWindow } from '../../common/utils/cursor.js';
import { parseCustomerMoney, webMoney } from '../../common/utils/currency.js';
import { iso } from '../../common/utils/time-display.js';
import type { INegotiation, INegotiationMessage, INegotiationOffer } from '../../models/web-trade.model.js';
import { requireKyc, requireUser } from '../auth/auth.middleware.js';
import { negotiationsService as svc, openOffer, statusFor } from './negotiations.service.js';
import type { OfferInput } from './negotiations.service.js';

const money = z.object({ amount: z.number().int().positive(), currency: z.string().length(3).default('USD') });
const offerBody = z.object({
  price: money,
  unit: z.enum(['g', 'kg', 'MT', 'oz']),
  quantity: z.number().positive().max(1e9),
  incoterm: z.string().min(3).max(10),
  namedPort: z.string().min(2).max(120),
  shipmentFrom: z.string().min(2).max(40),
  shipmentTo: z.string().min(2).max(40),
});
const startBody = z.object({ lotId: z.string().min(1), offer: offerBody, message: z.string().trim().max(2000).optional() });
const messageBody = z.object({ body: z.string().trim().min(1).max(4000) });
const idParam = z.object({ negotiationId: z.string().min(1) });
const offerParam = z.object({ negotiationId: z.string().min(1), offerId: z.string().min(1) });
const listQuery = z.object({
  status: z.enum(['awaiting_reply', 'offer_received', 'agreed', 'closed']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  perPage: z.coerce.number().int().min(1).max(100).optional(),
});

const toInput = (b: z.infer<typeof offerBody>): OfferInput => ({ ...b, price: parseCustomerMoney(b.price) });

const toWebOffer = (o: INegotiationOffer, viewerId: string) => ({
  id: o._id,
  author: o.authorId === viewerId ? 'me' : 'counterparty',
  price: webMoney(o.price),
  unit: o.unit,
  quantity: o.quantity,
  total: webMoney(o.total),
  incoterm: o.incoterm,
  namedPort: o.namedPort,
  shipmentFrom: o.shipmentFrom,
  shipmentTo: o.shipmentTo,
  state: o.state,
  inResponseTo: o.inResponseTo ?? null,
  expiresAt: iso(o.expiresAt),
  createdAt: iso(o.createdAt),
});

const toWebMessage = (m: INegotiationMessage, viewerId: string) => ({
  id: m._id,
  kind: m.kind,
  author: m.authorId ? (m.authorId === viewerId ? 'me' : 'counterparty') : 'system',
  body: m.body ?? null,
  offerId: m.offerId ?? null,
  event: m.event ?? null,
  createdAt: iso(m.createdAt),
});

export const toWebNegotiation = (n: INegotiation, viewerId: string) => ({
  id: n._id,
  reference: n.reference,
  lot: { id: n.lotId, name: n.lotName, summary: n.lotSummary, grade: n.lotGrade },
  role: n.buyerId === viewerId ? 'buyer' : 'seller',
  status: statusFor(n, viewerId),
  openOfferId: openOffer(n)?._id ?? null,
  agreedOfferId: n.agreedOfferId ?? null,
  contractId: n.contractId ?? null,
  lcId: n.lcId ?? null,
  offers: n.offers.map((o) => toWebOffer(o, viewerId)),
  unread: n.unread?.[viewerId] ?? 0,
  lastMessageAt: iso(n.lastMessageAt),
  lastMessagePreview: n.lastMessagePreview,
  version: n.version,
  createdAt: iso(n.createdAt),
  updatedAt: iso(n.updatedAt),
});

/** Web `/negotiations/*`: lot negotiation with a single-open-offer chain. */
export function webNegotiationsRouter(): Router {
  const r = Router();
  const nid = validate({ params: idParam });
  const oid = validate({ params: offerParam });

  r.post('/negotiations', requireUser, requireKyc, idempotencyKey(true), validate({ body: startBody }), ah(async (req, res) => {
    const userId = currentUserId(req);
    const out = await svc.start(userId, { lotId: req.body.lotId, offer: toInput(req.body.offer), message: req.body.message, idempotencyKey: requireKeyOrThrow(req) });
    if (out.replayed) res.setHeader('Idempotent-Replay', 'true');
    res.status(201).json(toWebNegotiation(await svc.load(userId, out.id), userId));
  }));

  r.get('/negotiations', requireUser, validate({ query: listQuery }), ah(async (req, res) => {
    const userId = currentUserId(req);
    const win = pageWindow(req.query as { page?: unknown; perPage?: unknown });
    const { rows, total } = await svc.list(userId, req.query.status as INegotiation['status'] | undefined, win.skip, win.perPage);
    res.json(buildOffsetPage(rows.map((n) => toWebNegotiation(n, userId)), total, win));
  }));

  r.get('/negotiations/:negotiationId', requireUser, nid, ah(async (req, res) => {
    const userId = currentUserId(req);
    const id = String(req.params.negotiationId);
    const [n, msgs] = await Promise.all([svc.load(userId, id), svc.messages(userId, id)]);
    res.json({ ...toWebNegotiation(n, userId), messages: msgs.map((m) => toWebMessage(m, userId)) });
  }));

  // Contract: GET /negotiations/{negotiationId}/messages
  r.get('/negotiations/:negotiationId/messages', requireUser, nid, ah(async (req, res) => {
    const userId = currentUserId(req);
    const msgs = await svc.messages(userId, String(req.params.negotiationId));
    res.json({ items: msgs.map((m) => toWebMessage(m, userId)) });
  }));

  r.post('/negotiations/:negotiationId/offers', requireUser, requireKyc, nid, validate({ body: offerBody }), ah(async (req, res) => {
    const userId = currentUserId(req);
    res.status(201).json(toWebNegotiation(await svc.submitOffer(userId, String(req.params.negotiationId), toInput(req.body)), userId));
  }));

  r.post('/negotiations/:negotiationId/offers/:offerId/counter', requireUser, requireKyc, oid, validate({ body: offerBody }), ah(async (req, res) => {
    const userId = currentUserId(req);
    res.status(201).json(toWebNegotiation(await svc.submitOffer(userId, String(req.params.negotiationId), toInput(req.body), String(req.params.offerId)), userId));
  }));

  r.post('/negotiations/:negotiationId/offers/:offerId/accept', requireUser, requireKyc, oid, ah(async (req, res) => {
    const userId = currentUserId(req);
    res.json(toWebNegotiation(await svc.accept(userId, String(req.params.negotiationId), String(req.params.offerId)), userId));
  }));

  r.post('/negotiations/:negotiationId/offers/:offerId/reject', requireUser, oid, ah(async (req, res) => {
    const userId = currentUserId(req);
    res.json(toWebNegotiation(await svc.reject(userId, String(req.params.negotiationId), String(req.params.offerId)), userId));
  }));

  r.post('/negotiations/:negotiationId/messages', requireUser, nid, validate({ body: messageBody }), ah(async (req, res) => {
    const userId = currentUserId(req);
    res.status(201).json(toWebMessage(await svc.sendMessage(userId, String(req.params.negotiationId), req.body.body), userId));
  }));

  r.post('/negotiations/:negotiationId/read', requireUser, nid, ah(async (req, res) => {
    await svc.markRead(currentUserId(req), String(req.params.negotiationId));
    res.status(204).end();
  }));

  return r;
}
