import { Router } from 'express';
import { z } from 'zod';
import { conflict, forbidden, notFound } from '../../common/errors/app-error.js';
import { idempotencyKey, requireKeyOrThrow } from '../../common/middleware/idempotency-key.js';
import { validate } from '../../common/middleware/validate.js';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { getUserContext, optionalUser, requireKyc, requireRole, requireUser } from '../auth/auth.middleware.js';
import { auctionsService as svc } from './auctions.service.js';
import type { ListState } from './auctions.service.js';
import { toMobileAuctionDetail, toMobileAuctionSummary, toMobileBid, toMobileBidPlaced } from './auctions.dto.js';

async function resolveAuction(ref: string) {
  try {
    return await svc.get(ref);
  } catch {
    const { AuctionModel } = await import('../../models/auction.model.js');
    const byRef = await AuctionModel.findOne({ reference: ref }).lean();
    if (!byRef) throw notFound('auction/not-found', 'Auction not found');
    return svc.get(byRef._id);
  }
}

export function createV2AuctionsRouter(): Router {
  const r = Router();

  r.get(
    '/',
    optionalUser,
    validate({
      query: z.object({
        status: z.enum(['live', 'upcoming', 'ended', 'mine']).optional(),
        cursor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const q = req.query as { status?: string; cursor?: string; limit?: number };
      const skip = q.cursor ? Number.parseInt(q.cursor, 10) || 0 : 0;
      const limit = q.limit ?? 24;
      if (q.status === 'mine') {
        if (!req.actor || req.actor.kind !== 'user') throw forbidden('auth/token-invalid', 'Sign in required');
        const mine = await svc.myBids(req.actor.userId, undefined, skip, limit);
        res.json({
          items: mine.rows,
          nextCursor: skip + mine.rows.length < mine.total ? String(skip + mine.rows.length) : null,
          total: mine.total,
        });
        return;
      }
      const status = (q.status as ListState | undefined) ?? 'live';
      const { rows, total } = await svc.list({ states: [status], skip, limit });
      res.json({
        items: rows.map(toMobileAuctionSummary),
        nextCursor: skip + rows.length < total ? String(skip + rows.length) : null,
        total,
      });
    }),
  );

  r.get(
    '/:ref',
    optionalUser,
    asyncHandler(async (req, res) => {
      const a = await resolveAuction(String(req.params.ref));
      const viewerId = req.actor?.kind === 'user' ? req.actor.userId : undefined;
      res.json(toMobileAuctionDetail(a, await svc.viewer(viewerId, [a])));
    }),
  );

  r.get(
    '/:ref/bids',
    optionalUser,
    asyncHandler(async (req, res) => {
      const a = await resolveAuction(String(req.params.ref));
      const { rows, total } = await svc.listBids(a._id, 0, 50);
      const viewerId = req.actor?.kind === 'user' ? req.actor.userId : undefined;
      res.json({ items: rows.map((b) => toMobileBid(a, b, viewerId)), total });
    }),
  );

  r.post(
    '/:ref/bids',
    requireUser,
    requireKyc,
    requireRole('buyer', 'both'),
    idempotencyKey(true),
    validate({
      body: z.object({
        amountMinor: z.number().int().positive(),
        version: z.number().int().nonnegative(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const { user } = getUserContext(req);
      const a = await resolveAuction(String(req.params.ref));
      const body = req.body as { amountMinor: number; version: number };
      const { result, replayed } = await svc.placeBid({
        auctionId: a._id,
        userId: user.id,
        client: req.apiClient === 'web' ? 'web' : 'mobile',
        amountMinor: body.amountMinor,
        currency: a.currency,
        expectedVersion: body.version,
        idempotencyKey: requireKeyOrThrow(req),
      });
      if (replayed) res.setHeader('Idempotent-Replay', 'true');
      res.status(201).json({ bid: toMobileBidPlaced(result).bid ?? result.bid, auction: result.auction });
    }),
  );

  r.put(
    '/:ref/auto-bid',
    requireUser,
    requireKyc,
    validate({ body: z.object({ maxMinor: z.number().int().positive() }) }),
    asyncHandler(async (req, res) => {
      const { user } = getUserContext(req);
      const a = await resolveAuction(String(req.params.ref));
      const out = await svc.setAutoBid(
        a._id,
        user.id,
        (req.body as { maxMinor: number }).maxMinor,
        a.currency,
        req.apiClient === 'web' ? 'web' : 'mobile',
      );
      res.json({ autoBid: { max: { amountMinor: out.ceilingMinor, currency: out.currency }, active: true } });
    }),
  );

  r.delete(
    '/:ref/auto-bid',
    requireUser,
    asyncHandler(async (req, res) => {
      const { user } = getUserContext(req);
      const a = await resolveAuction(String(req.params.ref));
      await svc.clearAutoBid(a._id, user.id);
      res.status(204).send();
    }),
  );

  r.put(
    '/:ref/reminder',
    requireUser,
    validate({ body: z.object({ channels: z.array(z.string()).optional() }) }),
    asyncHandler(async (req, res) => {
      const { user } = getUserContext(req);
      const a = await resolveAuction(String(req.params.ref));
      await svc.setReminder(a._id, user.id, (req.body as { channels?: string[] }).channels ?? ['push']);
      res.json({ ok: true });
    }),
  );

  r.delete(
    '/:ref/reminder',
    requireUser,
    asyncHandler(async (req, res) => {
      const { user } = getUserContext(req);
      const a = await resolveAuction(String(req.params.ref));
      await svc.clearReminder(a._id, user.id);
      res.status(204).send();
    }),
  );

  r.post(
    '/:ref/order',
    requireUser,
    requireKyc,
    asyncHandler(async (req, res) => {
      const { user } = getUserContext(req);
      const a = await resolveAuction(String(req.params.ref));
      const finalized = await svc.ensureFinalized(a);
      if (finalized.outcome?.result !== 'sold' || finalized.outcome.winnerId !== user.id) {
        throw conflict('auction/not-winner', 'Only the winning bidder can create the settlement order.');
      }
      if (finalized.outcome.settlementOrderId) {
        const { OrderModel } = await import('../../models/order.model.js');
        const existing = await OrderModel.findById(finalized.outcome.settlementOrderId).lean();
        res.status(200).json({ orderRef: existing?.reference ?? finalized.outcome.settlementOrderId });
        return;
      }
      // finalize() already creates settlement; re-run finalize to converge
      const again = await svc.finalize(a._id);
      if (!again?.outcome?.settlementOrderId) throw conflict('auction/settlement-pending', 'Settlement order is not ready yet.');
      const { OrderModel } = await import('../../models/order.model.js');
      const order = await OrderModel.findById(again.outcome.settlementOrderId).lean();
      res.status(201).json({ orderRef: order?.reference ?? again.outcome.settlementOrderId });
    }),
  );

  return r;
}
