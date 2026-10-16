import type { Request, Response } from 'express';
import { requireKeyOrThrow } from '../../common/middleware/idempotency-key.js';
import { buildCursorPage, buildOffsetPage, cursorWindow, pageWindow } from '../../common/utils/cursor.js';
import { parseCustomerMoney, webMoney } from '../../common/utils/currency.js';
import { getUserActor, currentUserId } from '../../common/http/actor.js';
import {
  toMobileAuctionDetail,
  toMobileAuctionSummary,
  toMobileBid,
  toMobileBidPlaced,
  toMobileMyBid,
  toMobileResult,
  toWebAuctionDetail,
  toWebAuctionSummary,
  toWebBid,
  toWebBidPlaced,
} from './auctions.dto.js';
import type { ListState } from './auctions.service.js';
import { auctionsService as svc } from './auctions.service.js';

const auctionId = (req: Request) => String(req.params.auctionId);
const viewerId = (req: Request) => getUserActor(req)?.userId;

type MoneyBody = { amount: number; currency: string; scale?: number };

export const auctionsController = {
  /* ── mobile ── */
  async listMobile(req: Request, res: Response) {
    const win = cursorWindow(req.query as { limit?: unknown; cursor?: unknown });
    const status = (req.query.status as ListState | undefined) ?? 'live';
    const { rows, total, counts } = await svc.list({ states: [status], skip: win.skip, limit: win.limit });
    res.json(buildCursorPage(rows.map(toMobileAuctionSummary), total, win, counts));
  },

  async detailMobile(req: Request, res: Response) {
    const a = await svc.get(auctionId(req));
    res.json(toMobileAuctionDetail(a, await svc.viewer(viewerId(req), [a])));
  },

  async bidsMobile(req: Request, res: Response) {
    const a = await svc.get(auctionId(req));
    const win = cursorWindow(req.query as { limit?: unknown; cursor?: unknown });
    const { rows, total } = await svc.listBids(a._id, win.skip, win.limit);
    res.json(buildCursorPage(rows.map((b) => toMobileBid(a, b, viewerId(req))), total, win));
  },

  async placeBidMobile(req: Request, res: Response) {
    const userId = currentUserId(req);
    const b = req.body as { amount: MoneyBody; version: number };
    const money = parseCustomerMoney(b.amount);
    const { result, replayed } = await svc.placeBid({
      auctionId: auctionId(req),
      userId,
      client: 'mobile',
      amountMinor: money.amountMinor,
      currency: money.currency,
      expectedVersion: b.version,
      idempotencyKey: requireKeyOrThrow(req),
    });
    if (replayed) res.setHeader('Idempotent-Replay', 'true');
    res.status(201).json(toMobileBidPlaced(result));
  },

  async result(req: Request, res: Response) {
    res.json(toMobileResult(await svc.resultFor(auctionId(req), currentUserId(req))));
  },

  async myBids(req: Request, res: Response) {
    const win = cursorWindow(req.query as { limit?: unknown; cursor?: unknown });
    const { rows, total, counts } = await svc.myBids(currentUserId(req), req.query.status as 'active' | 'won' | 'lost' | undefined, win.skip, win.limit);
    const page = buildCursorPage(rows.map(toMobileMyBid), total, win);
    res.json({ ...page, meta: { ...page.meta, counts } });
  },

  async watch(req: Request, res: Response) {
    await svc.watch(auctionId(req), currentUserId(req), Boolean((req.body as { notifyOnSimilar?: boolean }).notifyOnSimilar));
    res.status(204).end();
  },

  /* ── web ── */
  async listWeb(req: Request, res: Response) {
    const q = req.query as { state?: ListState[]; page?: unknown; perPage?: unknown };
    const win = pageWindow(q);
    const { rows, total } = await svc.list({ states: q.state ?? [], skip: win.skip, limit: win.perPage });
    const viewer = await svc.viewer(viewerId(req), rows);
    res.json(buildOffsetPage(rows.map((a) => toWebAuctionSummary(a, viewer)), total, win));
  },

  async detailWeb(req: Request, res: Response) {
    const a = await svc.get(auctionId(req));
    res.json(toWebAuctionDetail(a, await svc.viewer(viewerId(req), [a])));
  },

  async bidsWeb(req: Request, res: Response) {
    const a = await svc.get(auctionId(req));
    const win = pageWindow(req.query as { page?: unknown; perPage?: unknown });
    const { rows, total } = await svc.listBids(a._id, win.skip, win.perPage);
    res.json(buildOffsetPage(rows.map((b) => toWebBid(a, b, viewerId(req))), total, win));
  },

  async placeBidWeb(req: Request, res: Response) {
    const userId = currentUserId(req);
    const money = parseCustomerMoney((req.body as { amount: MoneyBody }).amount);
    const { result, replayed } = await svc.placeBid({
      auctionId: auctionId(req),
      userId,
      client: 'web',
      amountMinor: money.amountMinor,
      currency: money.currency,
      idempotencyKey: requireKeyOrThrow(req),
    });
    if (replayed) res.setHeader('Idempotent-Replay', 'true');
    res.status(201).json(toWebBidPlaced(result));
  },

  async putAutoBid(req: Request, res: Response) {
    const money = parseCustomerMoney((req.body as { ceiling: MoneyBody }).ceiling);
    const out = await svc.setAutoBid(auctionId(req), currentUserId(req), money.amountMinor, money.currency, 'web');
    res.json({
      ceiling: webMoney({ amountMinor: out.ceilingMinor, currency: out.currency }),
      currentBid: webMoney({ amountMinor: out.currentMinor, currency: out.currency }),
      strategy: 'minimum_increment',
      active: true,
    });
  },

  async deleteAutoBid(req: Request, res: Response) {
    await svc.clearAutoBid(auctionId(req), currentUserId(req));
    res.status(204).end();
  },

  async setReminder(req: Request, res: Response) {
    const b = req.body as { channels?: string[] };
    const { notifyAt } = await svc.setReminder(auctionId(req), currentUserId(req), b.channels ?? ['push']);
    res.status(201).json({ reminderSet: true, notifyAt: notifyAt.toISOString() });
  },

  async deleteReminder(req: Request, res: Response) {
    await svc.clearReminder(auctionId(req), currentUserId(req));
    res.status(204).end();
  },
};

