import type { Request, Response } from 'express';
import { unprocessable } from '../../common/errors/app-error.js';
import { requireKeyOrThrow } from '../../common/middleware/idempotency-key.js';
import { buildCursorPage, buildOffsetPage, cursorWindow, pageWindow } from '../../common/utils/cursor.js';
import { toGrams } from '../../common/utils/quantity.js';
import type { QuantityUnit } from '../../common/utils/quantity.js';
import { currentUser, currentUserId } from '../../common/http/actor.js';
import {
  toMobileOrderCreated,
  toMobileOrderDetail,
  toMobileOrderDocuments,
  toMobileOrderListItem,
  toMobileRequirementPrice,
  toMobileTracking,
  toWebDownload,
  toWebLogistics,
  toWebOrder,
  toWebOrderCreated,
  toWebOrderDetail,
  toWebOrderDocuments,
  toWebQuote,
  toWebTimeline,
} from './orders.dto.js';
import { ordersService as svc } from './orders.service.js';

const orderId = (req: Request) => String(req.params.orderId);

export const ordersController = {
  /* ── mobile ── */
  async priceRequirement(req: Request, res: Response) {
    const b = req.body as { productId: string; quantity: { value: number; unit: QuantityUnit } };
    const out = await svc.priceRequirement(b.productId, toGrams(b.quantity.value, b.quantity.unit));
    res.json(toMobileRequirementPrice(out));
  },

  async createMobile(req: Request, res: Response) {
    const actor = currentUser(req);
    const b = req.body as {
      productId?: string | null;
      cartId?: string | null;
      quantity?: { value: number; unit: QuantityUnit } | null;
      neededBy?: string;
      delivery: Record<string, string>;
    };
    if (b.productId && !b.quantity) throw unprocessable('quantity is required', { quantity: 'Required' });
    const { orderId: id, replayed } = await svc.createOrder({
      userId: actor.userId,
      client: 'mobile',
      source: b.productId && b.quantity ? { kind: 'product', productId: b.productId, grams: toGrams(b.quantity.value, b.quantity.unit) } : { kind: 'cart' },
      delivery: b.delivery,
      neededBy: b.neededBy,
      idempotencyKey: requireKeyOrThrow(req),
    });
    const order = await svc.getForUser(id, actor.userId, 'mobile');
    if (replayed) res.setHeader('Idempotent-Replay', 'true');
    res.status(201).json(toMobileOrderCreated(order));
  },

  async listMobile(req: Request, res: Response) {
    const userId = currentUserId(req);
    const win = cursorWindow(req.query as { limit?: unknown; cursor?: unknown });
    const { rows, total, counts } = await svc.list(userId, {
      client: 'mobile',
      tab: req.query.tab as 'active' | 'completed' | undefined,
      skip: win.skip,
      limit: win.limit,
    });
    res.json(buildCursorPage(rows.map(toMobileOrderListItem), total, win, counts));
  },

  async detailMobile(req: Request, res: Response) {
    res.json(toMobileOrderDetail(await svc.getForUser(orderId(req), currentUserId(req), 'mobile')));
  },

  async tracking(req: Request, res: Response) {
    res.json(toMobileTracking(await svc.getForUser(orderId(req), currentUserId(req), 'mobile')));
  },

  async documentsMobile(req: Request, res: Response) {
    res.json(toMobileOrderDocuments(await svc.getForUser(orderId(req), currentUserId(req), 'mobile')));
  },

  async confirmDelivery(req: Request, res: Response) {
    const b = req.body as { sealIntact: boolean; assayAccepted: boolean; note?: string | null; version?: number };
    const order = await svc.confirmDelivery(orderId(req), currentUserId(req), { ...b, note: b.note ?? undefined });
    res.json(toMobileOrderDetail(order));
  },

  /* ── web ── */
  async quote(req: Request, res: Response) {
    const b = req.body as { lotId: string; quantity: { value: number; unit: QuantityUnit }; paymentMethod: 'escrow' | 'wire' | 'lc' | 'btc' };
    const out = await svc.quote({
      userId: req.actor?.kind === 'user' ? req.actor.userId : undefined,
      lotId: b.lotId,
      grams: toGrams(b.quantity.value, b.quantity.unit),
      paymentMethod: b.paymentMethod,
    });
    res.json(toWebQuote(out.quote, out));
  },

  async createWeb(req: Request, res: Response) {
    const actor = currentUser(req);
    const b = req.body as {
      lotId: string;
      quantity: { value: number; unit: QuantityUnit };
      paymentMethod: 'escrow' | 'wire' | 'lc' | 'btc';
      quoteId?: string;
      deliveryAddress?: { city: string; region?: string | null; country: string };
      notes?: string;
    };
    const { orderId: id, replayed } = await svc.createOrder({
      userId: actor.userId,
      client: 'web',
      source: { kind: 'product', productId: b.lotId, grams: toGrams(b.quantity.value, b.quantity.unit) },
      paymentMethod: b.paymentMethod,
      quoteId: b.quoteId,
      delivery: b.deliveryAddress ? { city: b.deliveryAddress.city, region: b.deliveryAddress.region ?? undefined, country: b.deliveryAddress.country } : undefined,
      notes: b.notes,
      idempotencyKey: requireKeyOrThrow(req),
    });
    const order = await svc.getForUser(id, actor.userId, 'web');
    if (replayed) res.setHeader('Idempotent-Replay', 'true');
    res.status(201).json(toWebOrderCreated(order));
  },

  async listWeb(req: Request, res: Response) {
    const q = req.query as { side?: 'buy' | 'sell'; status?: 'active' | 'completed'; page?: unknown; perPage?: unknown };
    const win = pageWindow(q);
    const { rows, total } = await svc.list(currentUserId(req), { client: 'web', side: q.side, tab: q.status, skip: win.skip, limit: win.perPage });
    res.json(buildOffsetPage(rows.map(toWebOrder), total, win));
  },

  async detailWeb(req: Request, res: Response) {
    res.json(toWebOrderDetail(await svc.getForUser(orderId(req), currentUserId(req), 'web')));
  },

  async timeline(req: Request, res: Response) {
    res.json(toWebTimeline(await svc.getForUser(orderId(req), currentUserId(req), 'web')));
  },

  async logistics(req: Request, res: Response) {
    res.json(toWebLogistics(await svc.getForUser(orderId(req), currentUserId(req), 'web')));
  },

  async documentsWeb(req: Request, res: Response) {
    res.json(toWebOrderDocuments(await svc.getForUser(orderId(req), currentUserId(req), 'web')));
  },

  async download(req: Request, res: Response) {
    const { order, doc } = await svc.documentForDownload(orderId(req), currentUserId(req), String(req.params.documentId), 'web');
    res.json(toWebDownload(order, doc._id));
  },

  async cancel(req: Request, res: Response) {
    const order = await svc.cancel(orderId(req), currentUserId(req), (req.body as { reason?: string }).reason, 'web');
    res.json({ order: toWebOrder(order), refund: null });
  },
};
