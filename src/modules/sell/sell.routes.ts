import { Router } from 'express';
import { notFound } from '../../common/errors/app-error.js';
import { currentUser, currentUserId } from '../../common/http/actor.js';
import { ah } from '../../common/http/async-handler.js';
import { idempotencyKey, requireKeyOrThrow } from '../../common/middleware/idempotency-key.js';
import { validate } from '../../common/middleware/validate.js';
import { buildCursorPage, cursorWindow } from '../../common/utils/cursor.js';
import { mobileMoney } from '../../common/utils/currency.js';
import { mobileQuantity, toGrams } from '../../common/utils/quantity.js';
import { addMs, now } from '../../common/utils/clock.js';
import { agoDisplay, countdownDisplay, iso, watDisplay } from '../../common/utils/time-display.js';
import type { IBulkQuote, ISellDocument, ISellRequest } from '../../models/sell.model.js';
import { requireKyc, requireTransactionPin, requireUser } from '../auth/auth.middleware.js';
import { uploadsService } from '../uploads/uploads.service.js';
import { sellService as svc } from './sell.service.js';
import * as v from './sell.validation.js';

const TIMELINE_LABELS: Record<string, string> = {
  booked: 'Evaluation booked',
  evaluating: 'Evaluation in progress',
  offer_ready: 'Offer ready',
  sold: 'Sold - payout released',
  declined: 'Offer declined',
  expired: 'Offer expired',
  cancelled: 'Request cancelled',
  review_requested: 'Desk review requested',
  review_resolved: 'Desk review completed',
};

type Qty = { value: number; unit: 'g' | 'kg' | 't' };
const grams = (q: Qty) => toGrams(q.value, q.unit);

function toMobileOffer(r: ISellRequest) {
  const o = r.offer;
  if (!o) return null;
  const at = now();
  return {
    id: o._id,
    status: o.status,
    amount: mobileMoney(o.amount),
    issuedAt: iso(o.issuedAt),
    expiresAt: iso(o.expiresAt),
    countdown: o.status === 'open' && !o.pausedAt ? countdownDisplay(o.expiresAt, at) : null,
    paused: Boolean(o.pausedAt),
    assay: { grams: o.assay.grams, karat: o.assay.karat, purityPct: o.assay.purityPct, evaluatedAt: iso(o.assay.evaluatedAt), location: o.assay.location ?? null },
    version: o.version,
  };
}

export function toMobileSellRequest(r: ISellRequest) {
  const at = now();
  return {
    id: r._id,
    reference: r.reference,
    status: r.status,
    mineral: { id: r.mineralTypeId, name: r.mineralName },
    quantity: mobileQuantity(r.grams),
    photoIds: r.photoIds,
    pickup: r.pickup,
    evaluation: { at: iso(r.evaluation.at), display: watDisplay(r.evaluation.at), slotKey: r.evaluation.slotKey },
    payoutAccountId: r.payoutAccountId ?? null,
    estimateBand: r.estimateBand ? { low: mobileMoney(r.estimateBand.low), high: mobileMoney(r.estimateBand.high) } : null,
    evaluator: r.evaluator ?? null,
    offer: toMobileOffer(r),
    timeline: r.timeline.map((t) => ({ key: t.key, label: TIMELINE_LABELS[t.key] ?? t.key, at: iso(t.at), sub: t.sub ?? null })),
    createdAt: iso(r.createdAt),
    ago: agoDisplay(r.createdAt, at),
    version: r.version,
  };
}

const toMobileBulk = (q: IBulkQuote) => ({
  id: q._id,
  reference: q.reference,
  status: q.status,
  mineral: { id: q.mineralTypeId, name: q.mineralName },
  quantity: mobileQuantity(q.grams),
  purityPct: q.purityPct,
  band: { low: mobileMoney(q.band.low), high: mobileMoney(q.band.high) },
  expectedOfferBy: iso(q.expectedOfferBy),
  timeline: q.timeline.map((t) => ({ key: t.key, at: iso(t.at), sub: t.sub ?? null })),
  version: q.version,
  createdAt: iso(q.createdAt),
});

const toMobileSellDoc = (d: ISellDocument) => ({
  id: d._id,
  name: d.name,
  kind: d.kind,
  ready: d.ready,
  bytes: d.bytes ?? null,
  downloadUrl: d.ready && d.fileId ? uploadsService.signed(d.fileId).url : null,
  issuedAt: iso(d.issuedAt),
});

/** Mobile /sell/*. */
export function mobileSellRouter(): Router {
  const r = Router();
  const rid = validate({ params: v.requestIdParam });
  const id = (req: { params: Record<string, unknown> }) => String(req.params.requestId);

  r.get('/sell/mineral-types', requireUser, ah(async (req, res) => {
    const types = await svc.mineralTypes();
    const tier = currentUser(req).tier ?? 1;
    res.json({ data: types.map((t) => ({ id: t.id, slug: t.slug, name: t.name, mineralCode: t.mineralCode, available: t.tiers.includes(tier) })) });
  }));

  r.post('/sell/media', requireUser, validate({ body: v.mediaBody }), ah(async (req, res) => {
    const out = await uploadsService.createTarget(currentUserId(req), { purpose: 'sell-photo', ...(req.body as { filename: string; contentType: string; bytes: number }) });
    res.status(201).json({ fileId: out.file._id, upload: out.upload });
  }));

  r.post('/sell/estimates', requireUser, validate({ body: v.estimateBody }), ah(async (req, res) => {
    const b = req.body as { mineralTypeId: string; quantity: Qty; photoIds?: string[] };
    const e = await svc.estimate(currentUserId(req), { mineralTypeId: b.mineralTypeId, grams: grams(b.quantity), photoIds: b.photoIds });
    res.status(201).json({
      id: e._id,
      mineral: { id: e.mineralTypeId, name: e.mineralName },
      quantity: mobileQuantity(e.grams),
      assumedPurityPct: e.assumedPurityPct,
      low: mobileMoney(e.low),
      high: mobileMoney(e.high),
      midpoint: mobileMoney(e.midpoint),
      deductionPct: e.deductionBps / 100,
      rateAsOf: iso(e.rateAsOf),
      expiresAt: iso(e.expiresAt),
      disclaimer: 'Indicative only. The final offer follows an in-person assay.',
    });
  }));

  r.get('/sell/evaluation-slots', requireUser, validate({ query: v.slotsQuery }), ah(async (req, res) => {
    const slots = await svc.slots(req.query.from as string | undefined, Number(req.query.days ?? 7));
    res.json({ data: slots.map((s) => ({ key: s.key, at: iso(s.at), display: watDisplay(s.at), available: s.available })) });
  }));

  r.post('/sell/requests', requireUser, requireKyc, idempotencyKey(true), validate({ body: v.createRequestBody }), ah(async (req, res) => {
    const b = req.body as { estimateId?: string; mineralTypeId: string; quantity: Qty; photoIds: string[]; pickup: ISellRequest['pickup']; evaluation: { slotKey: string }; payoutAccountId?: string };
    const actor = currentUser(req);
    const out = await svc.create({
      userId: actor.userId,
      tier: actor.tier ?? 1,
      mineralTypeId: b.mineralTypeId,
      grams: grams(b.quantity),
      photoIds: b.photoIds,
      estimateId: b.estimateId,
      pickup: b.pickup,
      slotKey: b.evaluation.slotKey,
      payoutAccountId: b.payoutAccountId,
      idempotencyKey: requireKeyOrThrow(req),
    });
    if (out.replayed) res.setHeader('Idempotent-Replay', 'true');
    res.status(201).json(toMobileSellRequest(await svc.get(actor.userId, out.requestId)));
  }));

  r.get('/sell/requests', requireUser, validate({ query: v.listQuery }), ah(async (req, res) => {
    const win = cursorWindow(req.query as { limit?: unknown; cursor?: unknown });
    const { rows, total, counts } = await svc.list(currentUserId(req), req.query.status as 'active' | 'closed' | undefined, win.skip, win.limit);
    res.json(buildCursorPage(rows.map(toMobileSellRequest), total, win, counts));
  }));

  r.get('/sell/requests/:requestId', requireUser, rid, ah(async (req, res) => res.json(toMobileSellRequest(await svc.get(currentUserId(req), id(req))))));

  r.get('/sell/requests/:requestId/timeline', requireUser, rid, ah(async (req, res) => {
    res.json({ data: toMobileSellRequest(await svc.get(currentUserId(req), id(req))).timeline });
  }));

  r.get('/sell/requests/:requestId/documents', requireUser, rid, ah(async (req, res) => {
    res.json({ data: (await svc.documents(currentUserId(req), id(req))).map(toMobileSellDoc) });
  }));

  // Contract path: GET /sell/requests/{requestId}/offer
  r.get('/sell/requests/:requestId/offer', requireUser, rid, ah(async (req, res) => {
    const row = toMobileSellRequest(await svc.get(currentUserId(req), id(req)));
    if (!row.offer) throw notFound('sell/offer-not-found', 'No offer has been issued for this request yet');
    res.json(row.offer);
  }));

  r.delete('/sell/requests/:requestId', requireUser, rid, ah(async (req, res) => {
    res.json(toMobileSellRequest(await svc.cancel(currentUserId(req), id(req))));
  }));

  r.post('/sell/requests/:requestId/offer/accept', requireUser, requireKyc, rid, requireTransactionPin, validate({ body: v.acceptBody }), ah(async (req, res) => {
    res.json(toMobileSellRequest(await svc.acceptOffer(currentUserId(req), id(req), req.body)));
  }));
  r.post('/sell/requests/:requestId/offer/decline', requireUser, rid, validate({ body: v.declineBody }), ah(async (req, res) => {
    res.json(toMobileSellRequest(await svc.declineOffer(currentUserId(req), id(req), req.body)));
  }));
  r.post('/sell/requests/:requestId/offer/review', requireUser, rid, validate({ body: v.reviewBody }), ah(async (req, res) => {
    res.status(202).json(toMobileSellRequest(await svc.requestReview(currentUserId(req), id(req), req.body)));
  }));

  r.post('/sell/bulk-quotes/valuation', requireUser, validate({ body: v.valuationBody }), ah(async (req, res) => {
    const b = req.body as { mineralTypeId: string; quantity: Qty; purityPct: number };
    const out = await svc.valuation({ mineralTypeId: b.mineralTypeId, grams: grams(b.quantity), purityPct: b.purityPct });
    res.json({
      mineral: { id: out.mineral.id, name: out.mineral.name },
      band: { low: mobileMoney(out.band.low), high: mobileMoney(out.band.high) },
      asOf: iso(out.asOf),
      validUntil: iso(addMs(now(), 15 * 60_000)),
    });
  }));

  // Contract path: GET /sell/bulk-quotes/{quoteId}/valuation
  r.get('/sell/bulk-quotes/:quoteId/valuation', requireUser, validate({ params: v.quoteIdParam }), ah(async (req, res) => {
    const quoteId = String(req.params.quoteId);
    const bulk = await svc.getBulk(currentUserId(req), quoteId);
    const out = await svc.valuation({
      mineralTypeId: bulk.mineralTypeId,
      grams: bulk.grams,
      purityPct: bulk.purityPct,
    });
    res.json({
      quoteId,
      mineral: { id: out.mineral.id, name: out.mineral.name },
      band: { low: mobileMoney(out.band.low), high: mobileMoney(out.band.high) },
      asOf: iso(out.asOf),
      validUntil: iso(addMs(now(), 15 * 60_000)),
    });
  }));

  r.post('/sell/bulk-quotes', requireUser, requireKyc, idempotencyKey(true), validate({ body: v.bulkBody }), ah(async (req, res) => {
    const b = req.body as Record<string, unknown> & { quantity: Qty };
    const actor = currentUser(req);
    const out = await svc.createBulk(actor.userId, actor.tier ?? 1, { ...(b as unknown as Omit<Parameters<typeof svc.createBulk>[2], 'grams' | 'idempotencyKey'>), grams: grams(b.quantity), idempotencyKey: requireKeyOrThrow(req) });
    if (out.replayed) res.setHeader('Idempotent-Replay', 'true');
    res.status(201).json(toMobileBulk(await svc.getBulk(actor.userId, out.id)));
  }));
  r.get('/sell/bulk-quotes', requireUser, validate({ query: v.listQuery }), ah(async (req, res) => {
    const win = cursorWindow(req.query as { limit?: unknown; cursor?: unknown });
    const { rows, total } = await svc.listBulk(currentUserId(req), win.skip, win.limit);
    res.json(buildCursorPage(rows.map(toMobileBulk), total, win));
  }));
  r.get('/sell/bulk-quotes/:bulkQuoteId', requireUser, validate({ params: v.bulkIdParam }), ah(async (req, res) => {
    res.json(toMobileBulk(await svc.getBulk(currentUserId(req), String(req.params.bulkQuoteId))));
  }));

  return r;
}
