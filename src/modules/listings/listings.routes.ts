import { Router } from 'express';
import { z } from 'zod';
import { currentUserId } from '../../common/http/actor.js';
import { ah } from '../../common/http/async-handler.js';
import { idempotencyKey, requireKeyOrThrow } from '../../common/middleware/idempotency-key.js';
import { validate } from '../../common/middleware/validate.js';
import { buildOffsetPage, pageWindow } from '../../common/utils/cursor.js';
import { webMoney } from '../../common/utils/currency.js';
import { toGrams, webQuantity } from '../../common/utils/quantity.js';
import { iso } from '../../common/utils/time-display.js';
import type { IListing } from '../../models/web-trade.model.js';
import { requireKyc, requireUser } from '../auth/auth.middleware.js';
import { uploadsService } from '../uploads/uploads.service.js';
import { listingsService as svc } from './listings.service.js';
import type { ListingInput } from './listings.service.js';

const qty = z.object({ value: z.number().positive(), unit: z.enum(['g', 'kg', 'oz', 'ct', 'MT']) });
const address = z.object({
  city: z.string().min(1).max(100),
  region: z.string().max(100).optional(),
  country: z.string().length(2),
  countryName: z.string().max(100).optional(),
  streetAddress: z.string().max(240).optional(),
});
const base = {
  mineralId: z.string().max(20).nullish(),
  customMineralName: z.string().trim().min(2).max(100).nullish(),
  quantity: qty,
  form: z.enum(['raw', 'semi_finished', 'finished']).default('raw'),
  verificationAddress: address,
  preferredSlot: z.enum(['morning', 'afternoon', 'flexible']).default('flexible'),
  payoutMethodId: z.string().nullish(),
  payoutPreference: z.string().max(60).optional(),
};
const quoteBody = z.object({ mineralId: base.mineralId, customMineralName: base.customMineralName, quantity: qty });
const createBody = z.object({ ...base, submit: z.boolean().optional(), photoFileIds: z.array(z.string()).max(8).optional() });
const patchBody = z.object({
  mineralId: base.mineralId,
  customMineralName: base.customMineralName,
  quantity: qty.optional(),
  form: base.form.optional(),
  verificationAddress: address.optional(),
  preferredSlot: base.preferredSlot.optional(),
  payoutMethodId: base.payoutMethodId,
  payoutPreference: base.payoutPreference,
  submit: z.boolean().optional(),
  version: z.number().int().optional(),
});
const photoBody = z.object({ fileId: z.string().min(1) });
const idParam = z.object({ listingId: z.string().min(1) });
const listQuery = z.object({
  status: z.enum(['draft', 'submitted', 'visit_scheduled', 'verified', 'in_transit', 'received', 'paid', 'rejected']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  perPage: z.coerce.number().int().min(1).max(100).optional(),
});

const toWebListing = (l: IListing) => ({
  id: l._id,
  reference: l.reference,
  status: l.status,
  mineral: { id: l.mineralId ?? null, name: l.mineralName, custom: l.customMineralName ?? null, category: l.categoryKey },
  quantity: webQuantity(l.grams),
  form: l.form,
  verificationAddress: l.verificationAddress,
  preferredSlot: l.preferredSlot,
  payoutMethodId: l.payoutMethodId ?? null,
  photos: l.photos.map((p) => ({ id: p._id, fileId: p.fileId, url: uploadsService.signed(p.fileId).url })),
  indicativeNet: l.indicativeNet ? webMoney(l.indicativeNet) : null,
  quote: l.quoteSnapshot ? { gross: webMoney(l.quoteSnapshot.gross), fee: webMoney(l.quoteSnapshot.fee), net: webMoney(l.quoteSnapshot.net), feeBps: l.quoteSnapshot.feeBps } : null,
  submittedAt: iso(l.submittedAt),
  visitScheduledFor: iso(l.visitScheduledFor),
  verification: l.verification ?? null,
  orderId: l.orderId ?? null,
  version: l.version,
  createdAt: iso(l.createdAt),
  updatedAt: iso(l.updatedAt),
});

type Body = { quantity?: z.infer<typeof qty> } & Record<string, unknown>;
const withGrams = (b: Body): Partial<ListingInput> => {
  const { quantity, ...rest } = b;
  return { ...(rest as Partial<ListingInput>), ...(quantity ? { quantityGrams: toGrams(quantity.value, quantity.unit) } : {}) };
};

/** Web `/listings` (sell side). */
export function webListingsRouter(): Router {
  const r = Router();
  const id = validate({ params: idParam });

  r.post('/listings/quote', requireUser, validate({ body: quoteBody }), ah(async (req, res) => {
    const out = await svc.quote(withGrams(req.body) as Pick<ListingInput, 'mineralId' | 'customMineralName' | 'quantityGrams'>);
    res.json({
      mineral: out.mineral,
      quote: out.quote ? { gross: webMoney(out.quote.gross), fee: webMoney(out.quote.fee), net: webMoney(out.quote.net), feeBps: out.quote.feeBps, assumedPurityPct: out.quote.assumedPurityPct, asOf: iso(out.quote.asOf) } : null,
      disclaimer: 'Indicative only. The final payout follows on-site verification and assay.',
    });
  }));

  r.post('/listings', requireUser, requireKyc, idempotencyKey(true), validate({ body: createBody }), ah(async (req, res) => {
    const userId = currentUserId(req);
    const out = await svc.create(userId, { ...(withGrams(req.body) as ListingInput), submit: req.body.submit, photoFileIds: req.body.photoFileIds, idempotencyKey: requireKeyOrThrow(req) });
    if (out.replayed) res.setHeader('Idempotent-Replay', 'true');
    res.status(201).json(toWebListing(await svc.get(userId, out.id)));
  }));

  r.get('/listings', requireUser, validate({ query: listQuery }), ah(async (req, res) => {
    const win = pageWindow(req.query as { page?: unknown; perPage?: unknown });
    const { rows, total } = await svc.list(currentUserId(req), req.query.status as IListing['status'] | undefined, win.skip, win.perPage);
    res.json(buildOffsetPage(rows.map(toWebListing), total, win));
  }));

  r.get('/listings/:listingId', requireUser, id, ah(async (req, res) => res.json(toWebListing(await svc.get(currentUserId(req), String(req.params.listingId))))));

  r.patch('/listings/:listingId', requireUser, id, validate({ body: patchBody }), ah(async (req, res) => {
    res.json(toWebListing(await svc.patch(currentUserId(req), String(req.params.listingId), withGrams(req.body) as Partial<ListingInput> & { submit?: boolean; version?: number } & Record<string, unknown>)));
  }));

  r.post('/listings/:listingId/photos', requireUser, id, validate({ body: photoBody }), ah(async (req, res) => {
    res.status(201).json(toWebListing(await svc.addPhoto(currentUserId(req), String(req.params.listingId), req.body.fileId)));
  }));

  r.delete('/listings/:listingId/photos/:photoId', requireUser, validate({ params: z.object({ listingId: z.string().min(1), photoId: z.string().min(1) }) }), ah(async (req, res) => {
    res.json(toWebListing(await svc.removePhoto(currentUserId(req), String(req.params.listingId), String(req.params.photoId))));
  }));

  return r;
}
