import { AppError, conflict, forbidden, notFound, unprocessable } from '../../common/errors/app-error.js';
import type { ApiClient } from '../../common/middleware/request-context.js';
import { runIdempotent, idempotencyScope } from '../../common/idempotency/idempotency.js';
import { addMs, DAY_MS, MINUTE_MS, now } from '../../common/utils/clock.js';
import { opaqueId } from '../../common/utils/ids.js';
import { feeMinor, FEES, quotedPriceToE4PerGram, totalMinor } from '../../common/utils/pricing-math.js';
import { commercialUnit, fromGrams, gramsInUnit, type QuantityUnit } from '../../common/utils/quantity.js';
import { references } from '../../common/utils/references.js';
import { channels, realtimeHub } from '../../realtime/auction-hub.js';
import type { IOrder, IOrderLine, OrderStatus, PaymentMethod } from '../../models/order.model.js';
import type { IProduct } from '../../models/catalog.model.js';
import type { IUser } from '../../models/user.model.js';
import type { MoneyDoc } from '../../models/_shared.js';
import { projectCustomerAccount, projectCustomerOrder, safeProject } from '../../integration/customer-admin.bridge.js';
import { notifyUser } from '../notifications/notifications.service.js';
import { docsFor, orderMachine, STAGE_COUNT, stagesFor, statusForStage } from './order.stages.js';
import { ordersRepository as repo } from './orders.repository.js';

const QUOTE_TTL_MS = 5 * MINUTE_MS;
const MIN_LEAD_DAYS = 3;

export type OrderSourceInput = { kind: 'product'; productId: string; grams: number } | { kind: 'cart' };

export type DeliveryInput = {
  addressId?: string;
  facilityName?: string;
  streetAddress?: string;
  city?: string;
  region?: string;
  country?: string;
  contactPerson?: string;
  contactPhone?: string;
  importPermitNumber?: string;
};

export type CreateOrderInput = {
  userId: string;
  client: ApiClient;
  source: OrderSourceInput;
  paymentMethod?: PaymentMethod;
  delivery?: DeliveryInput;
  neededBy?: string;
  notes?: string;
  quoteId?: string;
  idempotencyKey: string;
};

type Totals = { subtotal: MoneyDoc; platformFee: MoneyDoc; surcharge: MoneyDoc; total: MoneyDoc };

function buildTotals(lines: IOrderLine[], currency: string, feeBps: number, method: PaymentMethod): Totals {
  const subtotalMinor = lines.reduce((s, l) => s + l.lineTotalMinor, 0);
  const fee = feeMinor(subtotalMinor, feeBps);
  const sur = feeMinor(subtotalMinor, FEES.surcharge[method] ?? 0);
  return {
    subtotal: { amountMinor: subtotalMinor, currency },
    platformFee: { amountMinor: fee, currency },
    surcharge: { amountMinor: sur, currency },
    total: { amountMinor: subtotalMinor + fee + sur, currency },
  };
}

function sellingUnit(p: IProduct): QuantityUnit {
  return commercialUnit(p.attributes?.unit) ?? 'g';
}

function quantityLabel(grams: number, unit: QuantityUnit): string {
  return `${fromGrams(grams, unit)} ${unit}`;
}

/** The price the customer sees (`listPrice` per selling unit), otherwise the stored per-gram rate. */
function unitPriceE4(p: IProduct): number {
  const list = p.attributes?.listPrice;
  const unit = p.attributes?.unit;
  if (typeof list === 'number' && list > 0 && typeof unit === 'string' && gramsInUnit(unit) > 0) {
    return quotedPriceToE4PerGram(list, unit);
  }
  return p.unitPriceMinorE4PerGram;
}

function lineFor(p: IProduct, grams: number): IOrderLine {
  const unitPriceMinorE4PerGram = unitPriceE4(p);
  return {
    productId: p._id,
    name: p.name,
    imageUrl: p.imageUrl,
    grams,
    unitPriceMinorE4PerGram,
    lineTotalMinor: totalMinor(grams, unitPriceMinorE4PerGram),
  };
}

function unavailable(client: ApiClient): AppError {
  return client === 'mobile'
    ? conflict('catalog/product-unavailable', 'This product is no longer available.')
    : conflict('lot/unavailable', 'This lot is no longer available.');
}

function insufficient(client: ApiClient, availableGrams: number, unit: QuantityUnit): AppError {
  const label = quantityLabel(availableGrams, unit);
  return client === 'mobile'
    ? unprocessable('Requested more than is available', { quantity: label }, 'catalog/insufficient-quantity')
    : conflict('lot/insufficient-stock', `Not enough quantity is available. ${label} can be ordered.`, { current: { availableGrams } });
}

async function loadSellableProduct(productId: string, grams: number, client: ApiClient): Promise<IProduct> {
  const p = await repo.findProduct(productId);
  if (!p || p.status !== 'active') throw unavailable(client);
  const unit = sellingUnit(p);
  if (!(grams > 0)) {
    throw unprocessable('Enter a quantity greater than zero', { quantity: 'Enter a quantity greater than zero' }, 'order/invalid-quantity');
  }
  // A catalog row inserted without an availability figure stays at 0 g. That is not a sold-out lot.
  if (p.availableGrams > 0 && grams > p.availableGrams) throw insufficient(client, p.availableGrams, unit);
  return p;
}

function resolveDelivery(user: IUser, d: DeliveryInput | undefined, tier: number, client: ApiClient): IOrder['delivery'] {
  if (client !== 'mobile') return d ? { ...d } : undefined;
  let out: DeliveryInput = { ...(d ?? {}) };
  if (out.addressId) {
    const a = user.addresses.find((x) => x.id === out.addressId);
    if (!a) throw unprocessable('Delivery address not found', { 'delivery.addressId': 'Unknown address' });
    out = {
      ...out,
      facilityName: out.facilityName ?? a.label,
      streetAddress: out.streetAddress ?? a.streetAddress,
      city: out.city ?? a.city,
      region: out.region ?? a.region,
      country: out.country ?? a.country,
      contactPerson: out.contactPerson ?? a.contactPerson,
      contactPhone: out.contactPhone ?? a.contactPhone,
    };
  }
  const missing = (['facilityName', 'streetAddress', 'city', 'country', 'contactPerson', 'contactPhone'] as const).filter((k) => !out[k]);
  if (missing.length) {
    throw new AppError({
      status: 422,
      code: 'order/address-incomplete',
      message: 'Delivery facility details are incomplete',
      fields: Object.fromEntries(missing.map((k) => [`delivery.${k}`, 'Required'])),
    });
  }
  if (tier === 3 && !out.importPermitNumber) {
    throw new AppError({
      status: 422,
      code: 'order/permit-required',
      message: 'An import permit number is required for Tier 3 accounts',
      fields: { 'delivery.importPermitNumber': 'Required for Tier 3' },
    });
  }
  if (tier !== 3 && out.importPermitNumber) {
    throw new AppError({
      status: 422,
      code: 'validation/failed',
      message: 'Import permit is only accepted for Tier 3 accounts',
      fields: { 'delivery.importPermitNumber': 'Not accepted for this tier' },
    });
  }
  return out;
}

function assertNeededBy(neededBy: string | undefined): void {
  if (!neededBy) return;
  const t = Date.parse(`${neededBy}T00:00:00Z`);
  if (Number.isNaN(t)) throw unprocessable('Invalid date', { neededBy: 'Use YYYY-MM-DD' });
  if (t < now().getTime() + MIN_LEAD_DAYS * DAY_MS) {
    throw new AppError({
      status: 422,
      code: 'order/needed-by-too-soon',
      message: `Earliest delivery is ${MIN_LEAD_DAYS} days from today`,
      fields: { neededBy: `At least ${MIN_LEAD_DAYS} days ahead` },
    });
  }
}

export const ordersService = {
  /** Mobile `POST /orders/requirements/price`: indicative pricing, nothing reserved. */
  async priceRequirement(productId: string, grams: number) {
    const p = await loadSellableProduct(productId, grams, 'mobile');
    const line = lineFor(p, grams);
    return {
      grams,
      unitPriceMinorE4PerGram: p.unitPriceMinorE4PerGram,
      indicativeTotal: { amountMinor: line.lineTotalMinor, currency: p.currency },
      rateAsOf: now(),
    };
  },

  /** Web `POST /orders/quote`: a short-lived quote the order create must honour (409 order/quote-expired). */
  async quote(input: { userId?: string; lotId: string; grams: number; paymentMethod: PaymentMethod }) {
    const p = await repo.findProduct(input.lotId);
    if (!p || p.status === 'draft') throw notFound('lot/not-found', 'Lot not found');
    const line = lineFor(p, input.grams);
    const t = buildTotals([line], p.currency, FEES.webBuyPlatformBps, input.paymentMethod);
    const q = await repo.saveQuote({
      userId: input.userId,
      lotId: p._id,
      grams: input.grams,
      paymentMethod: input.paymentMethod,
      unitPriceMinorE4PerGram: p.unitPriceMinorE4PerGram,
      ...t,
      expiresAt: addMs(now(), QUOTE_TTL_MS),
    });
    const tracked = p.availableGrams > 0;
    return {
      quote: q,
      availableGrams: p.availableGrams,
      withinAvailable: !tracked || input.grams <= p.availableGrams,
      minOrderGrams: p.minOrderGrams,
      unit: sellingUnit(p),
      meetsMinimum: input.grams > 0,
      feeBps: FEES.webBuyPlatformBps,
    };
  },

  /**
   * Create an order exactly once per Idempotency-Key. Stock is reserved with an atomic
   * conditional decrement; any failure after reservation releases it again.
   */
  async createOrder(input: CreateOrderInput): Promise<{ orderId: string; replayed: boolean }> {
    const outcome = await runIdempotent<{ orderId: string }>({
      scope: idempotencyScope(input.userId, 'order:create'),
      key: input.idempotencyKey,
      body: { source: input.source, paymentMethod: input.paymentMethod, delivery: input.delivery, neededBy: input.neededBy, quoteId: input.quoteId, notes: input.notes },
      successStatus: 201,
      fn: async () => ({ orderId: await this.createOrderOnce(input) }),
    });
    return { orderId: outcome.result.orderId, replayed: outcome.replayed };
  },

  async createOrderOnce(input: CreateOrderInput): Promise<string> {
    const user = await repo.findUser(input.userId);
    if (!user) throw notFound('user/not-found', 'User not found');
    const client = input.client;
    const method: PaymentMethod = input.paymentMethod ?? 'escrow';
    assertNeededBy(input.neededBy);
    const delivery = resolveDelivery(user, input.delivery, user.tier, client);

    // 1. resolve lines
    let lines: IOrderLine[] = [];
    let sourceRef: IOrder['source'];
    let feeBps = 0;
    let currency = 'USD';
    let unitOverride: { unit: number; totals: Totals } | null = null;

    if (input.source.kind === 'product') {
      const grams = input.source.grams;
      const p = await loadSellableProduct(input.source.productId, grams, client);
      currency = p.currency;
      lines = [lineFor(p, grams)];
      sourceRef = { kind: client === 'mobile' ? 'product' : 'lot', refId: p._id };
      feeBps = client === 'web' ? FEES.webBuyPlatformBps : 0;
      if (input.quoteId) {
        const q = await repo.findQuote(input.quoteId);
        if (!q || q.expiresAt <= now()) throw conflict('order/quote-expired', 'Your price quote has expired. Request a new quote.');
        if (q.lotId !== p._id || q.grams !== grams || q.paymentMethod !== method) {
          throw conflict('order/quote-mismatch', 'The quote does not match this order.');
        }
        unitOverride = { unit: q.unitPriceMinorE4PerGram, totals: { subtotal: q.subtotal, platformFee: q.platformFee, surcharge: q.surcharge, total: q.total } };
        lines = [{ ...lines[0]!, unitPriceMinorE4PerGram: q.unitPriceMinorE4PerGram, lineTotalMinor: q.subtotal.amountMinor }];
      }
    } else {
      const cart = await repo.findCart(input.userId);
      if (!cart || cart.items.length === 0) throw unprocessable('Your cart is empty', { cart: 'Empty' }, 'cart/empty');
      for (const item of cart.items) {
        const p = await loadSellableProduct(item.productId, item.grams, client);
        currency = p.currency;
        lines.push(lineFor(p, item.grams));
      }
      sourceRef = { kind: 'cart', refId: cart._id };
      feeBps = FEES.mobileCartHandlingBps;
    }

    const totals = unitOverride ? unitOverride.totals : buildTotals(lines, currency, feeBps, method);
    const totalGrams = lines.reduce((s, l) => s + l.grams, 0);

    // 2. reserve stock atomically (compensate on any later failure)
    const reserved: { productId: string; grams: number }[] = [];
    try {
      for (const l of lines) {
        if (!l.productId) continue;
        const stocked = await repo.findProduct(l.productId);
        // Only an active row with no availability figure skips reservation; a depleted lot is already `sold`.
        if (stocked && stocked.status === 'active' && stocked.availableGrams === 0) continue;
        const ok = await repo.reserveStock(l.productId, l.grams);
        if (!ok) {
          const p = await repo.findProduct(l.productId);
          throw p && p.status === 'active' ? insufficient(client, p.availableGrams, sellingUnit(p)) : unavailable(client);
        }
        reserved.push({ productId: l.productId, grams: l.grams });
      }

      const at = now();
      const firstProduct = lines[0]?.productId ? await repo.findProduct(lines[0].productId) : null;
      const order = await repo.insert({
        reference: await references.order(),
        userId: input.userId,
        side: 'buy',
        status: 'pending_review',
        stageIndex: 0,
        stageHistory: [{ index: 0, key: stagesFor('buy')[0]!.key, at }],
        source: sourceRef,
        lines,
        totalGrams,
        ...totals,
        paymentMethod: method,
        paymentTaken: false,
        quoteId: input.quoteId,
        delivery,
        neededBy: input.neededBy,
        notes: input.notes,
        settlement: { method, status: 'not_funded' },
        counterparty: firstProduct ? { name: firstProduct.seller.name, type: firstProduct.seller.tier, verified: firstProduct.seller.verified } : undefined,
        region: delivery?.region ?? delivery?.city,
        documents: docsFor('buy').map((d) => ({ _id: opaqueId('doc'), ...d })),
        version: 0,
      });
      if (input.source.kind === 'cart') await repo.clearCart(input.userId);

      await safeProject('order', async () => {
        await projectCustomerAccount({
          id: user._id.toString(),
          name: user.profile?.fullName || user.profile?.displayName || 'Customer',
          email: user.email,
          phone: user.phone,
          org: user.profile?.companyName,
          country: user.profile?.countryCode,
          tier: user.tier,
          kycStatus: user.kycStatus,
        });
        await projectCustomerOrder(order);
      });

      void notifyUser(input.userId, {
        event: 'order.stage_changed',
        title: `Order ${order.reference} received`,
        body: 'The verification desk will review it within 24 hours. No payment has been taken.',
        target: { type: 'order', id: order._id },
        data: { orderId: order._id, stageIndex: 0 },
      });
      return order._id;
    } catch (err) {
      await Promise.all(reserved.map((r) => repo.restoreStock(r.productId, r.grams)));
      throw err;
    }
  },

  /** Settlement order for an auction win; unique per auction via `settlementKey`. */
  async createAuctionSettlementOrder(a: { auctionId: string; name: string; imageUrl?: string; grams: number; winnerId: string; amountMinor: number; currency: string }) {
    const key = `auction:${a.auctionId}`;
    const existing = await repo.findBySettlementKey(key);
    if (existing) return existing;
    const unit = Math.round((a.amountMinor * 10_000) / Math.max(1, a.grams));
    const line: IOrderLine = { name: a.name, imageUrl: a.imageUrl, grams: a.grams, unitPriceMinorE4PerGram: unit, lineTotalMinor: a.amountMinor };
    const money = (n: number): MoneyDoc => ({ amountMinor: n, currency: a.currency });
    try {
      return await repo.insert({
        reference: await references.order(),
        userId: a.winnerId,
        side: 'buy',
        status: 'pending_review',
        stageIndex: 0,
        stageHistory: [{ index: 0, key: 'verification', at: now(), note: 'Auction win' }],
        source: { kind: 'auction', refId: a.auctionId },
        lines: [line],
        totalGrams: a.grams,
        subtotal: money(a.amountMinor),
        platformFee: money(0),
        surcharge: money(0),
        total: money(a.amountMinor),
        priceConfirmed: true,
        paymentMethod: 'escrow',
        paymentTaken: false,
        settlement: { method: 'escrow', status: 'not_funded' },
        documents: docsFor('buy').map((d) => ({ _id: opaqueId('doc'), ...d })),
        settlementKey: key,
        version: 0,
      });
    } catch (err) {
      if (repo.isDuplicateKey(err)) {
        const again = await repo.findBySettlementKey(key);
        if (again) return again;
      }
      throw err;
    }
  },

  /** Party check. Web contract demands 403 (never 404, which would leak existence). */
  async getForUser(orderId: string, userId: string, client: ApiClient): Promise<IOrder> {
    const order = await repo.findById(orderId);
    if (!order) {
      if (client === 'web') throw forbidden('auth/forbidden', 'You are not a party to this order');
      throw notFound('order/not-found', 'Order not found');
    }
    if (order.userId !== userId) {
      if (client === 'web') throw forbidden('auth/forbidden', 'You are not a party to this order');
      throw notFound('order/not-found', 'Order not found');
    }
    return order;
  },

  async list(userId: string, q: { client: ApiClient; tab?: 'active' | 'completed'; side?: 'buy' | 'sell'; skip: number; limit: number }) {
    const activeStatuses: OrderStatus[] = ['pending_review', 'active'];
    const closedStatuses: OrderStatus[] = ['completed', 'rejected', 'cancelled'];
    const filter: Record<string, unknown> = { userId };
    if (q.client === 'mobile') filter.side = 'buy';
    else if (q.side) filter.side = q.side;
    if (q.tab) filter.status = { $in: q.tab === 'active' ? activeStatuses : closedStatuses };
    const { rows, total } = await repo.list(filter, q.skip, q.limit);
    const base: Record<string, unknown> = { userId, ...(q.client === 'mobile' ? { side: 'buy' } : q.side ? { side: q.side } : {}) };
    const [active, completed, selling] = await Promise.all([
      repo.count({ ...base, status: { $in: activeStatuses } }),
      repo.count({ ...base, status: { $in: closedStatuses } }),
      q.client === 'mobile' ? repo.countSelling(userId) : Promise.resolve(0),
    ]);
    return { rows, total, counts: { active, selling, completed } };
  },

  /** Advance the pipeline by exactly one stage (desk/system action). Enforces ordering with 409. */
  async advanceStage(orderId: string, toIndex: number, opts: { note?: string } = {}): Promise<IOrder> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const order = await repo.findById(orderId);
      if (!order) throw notFound('order/not-found', 'Order not found');
      if (order.status === 'rejected' || order.status === 'cancelled' || order.status === 'completed') {
        throw conflict('order/invalid-transition', `Order is ${order.status}`, { current: { status: order.status } });
      }
      if (toIndex !== order.stageIndex + 1 || toIndex >= STAGE_COUNT) {
        throw conflict('order/invalid-transition', `Cannot jump from stage ${order.stageIndex} to ${toIndex}`, {
          current: { stageIndex: order.stageIndex },
        });
      }
      const nextStatus = statusForStage(toIndex);
      if (nextStatus !== order.status) orderMachine.assert(order.status, nextStatus);
      const at = now();
      const stage = stagesFor(order.side)[toIndex]!;
      const set: Record<string, unknown> = { stageIndex: toIndex, status: nextStatus };
      if (order.side === 'buy') {
        if (toIndex === 2) {
          set['settlement.status'] = 'held';
          set['settlement.fundedAt'] = at;
          set['settlement.escrowReference'] = `ESC-${order._id.slice(-8).toUpperCase()}`;
          set.paymentTaken = true;
        }
        if (toIndex === 3) set.seal = { reference: await references.seal(), photographedAt: at };
        if (toIndex === 4) {
          set.carrier = { name: 'Fidelis Secure Logistics', bonded: true, escorts: 2 };
          set.eta = { from: addMs(at, 2 * DAY_MS), to: addMs(at, 2 * DAY_MS + 3 * 3_600_000) };
          set.route = { from: 'MB VAULT', to: (order.delivery?.city ?? 'DESTINATION').toUpperCase(), progress: 10, updatedAt: at };
        }
        if (toIndex === 5) {
          set['settlement.status'] = 'released';
          set['settlement.releasedAt'] = at;
        }
      }
      const updated = await repo.casUpdate(
        order._id,
        order.version,
        { $set: set, $push: { stageHistory: { index: toIndex, key: stage.key, at, note: opts.note } } },
        { stageIndex: order.stageIndex },
      );
      if (!updated) continue; // lost a race: re-read and re-validate
      const progressPercent = Math.round(((toIndex + 1) / STAGE_COUNT) * 100);
      realtimeHub.publish(channels.user(order.userId), 'order.stage_changed', {
        orderId: order._id,
        stageIndex: toIndex,
        stageTitle: stage.title,
        progressPercent,
      });
      void notifyUser(order.userId, {
        event: toIndex === 5 ? 'order.delivered' : 'order.stage_changed',
        title: `Order ${order.reference}: ${stage.title}`,
        body: stage.subtitle,
        target: { type: 'order', id: order._id },
        data: { orderId: order._id, stageIndex: toIndex },
      });
      return updated;
    }
    throw conflict('order/concurrent-update', 'Order was modified concurrently; retry');
  },

  async reject(orderId: string, reason: string): Promise<IOrder> {
    const order = await repo.findById(orderId);
    if (!order) throw notFound('order/not-found', 'Order not found');
    orderMachine.assert(order.status, 'rejected');
    const updated = await repo.casUpdate(order._id, order.version, {
      $set: { status: 'rejected', rejection: { reason, stageIndex: order.stageIndex, at: now() } },
    });
    if (!updated) throw conflict('order/concurrent-update', 'Order was modified concurrently; retry');
    await Promise.all(order.lines.map((l) => (l.productId ? repo.restoreStock(l.productId, l.grams) : Promise.resolve())));
    return updated;
  },

  /** Cancel is only valid before escrow is funded (409 order/not-cancellable). */
  async cancel(orderId: string, userId: string, reason: string | undefined, client: ApiClient): Promise<IOrder> {
    const order = await this.getForUser(orderId, userId, client);
    if (order.status === 'cancelled') return order;
    const fundedOrBeyond = order.settlement.status !== 'not_funded' || order.stageIndex >= 2;
    if (fundedOrBeyond || !orderMachine.can(order.status, 'cancelled')) {
      throw conflict('order/not-cancellable', 'This order can no longer be cancelled.', { current: { status: order.status, stageIndex: order.stageIndex } });
    }
    const updated = await repo.casUpdate(
      order._id,
      order.version,
      { $set: { status: 'cancelled', cancellation: { reason, at: now(), refundMinor: 0 } } },
      { 'settlement.status': 'not_funded', status: order.status },
    );
    if (!updated) throw conflict('order/not-cancellable', 'This order can no longer be cancelled.');
    await Promise.all(order.lines.map((l) => (l.productId ? repo.restoreStock(l.productId, l.grams) : Promise.resolve())));
    return updated;
  },

  async confirmDelivery(orderId: string, userId: string, input: { sealIntact: boolean; assayAccepted: boolean; note?: string; version?: number }): Promise<IOrder> {
    const order = await this.getForUser(orderId, userId, 'mobile');
    if (order.status === 'completed' || order.deliveryConfirmation) {
      throw conflict('order/already-confirmed', 'Delivery was already confirmed.');
    }
    if (order.status !== 'active' || order.stageIndex < 4) {
      throw conflict('order/not-deliverable', 'This order has not arrived yet.', { current: { stageIndex: order.stageIndex } });
    }
    if (input.version !== undefined && input.version !== order.version) {
      throw conflict('order/stale', 'The order changed. Review and try again.', { current: { version: order.version, status: order.status } });
    }
    if (!input.sealIntact || !input.assayAccepted) {
      throw unprocessable('Delivery can only be confirmed when the seal is intact and the assay is accepted. Contact support to dispute.', {
        sealIntact: input.sealIntact ? '' : 'Seal must be intact',
        assayAccepted: input.assayAccepted ? '' : 'Assay must be accepted',
      }, 'order/delivery-not-accepted');
    }
    const at = now();
    const updated = await repo.casUpdate(
      order._id,
      order.version,
      {
        $set: {
          stageIndex: 5,
          status: 'completed',
          deliveryConfirmation: { sealIntact: true, assayAccepted: true, note: input.note, at },
          'settlement.status': 'released',
          'settlement.releasedAt': at,
        },
        $push: { stageHistory: { index: 5, key: 'delivered', at, note: input.note } },
      },
      { status: 'active', stageIndex: 4 },
    );
    if (!updated) throw conflict('order/already-confirmed', 'Delivery was already confirmed.');
    realtimeHub.publish(channels.user(userId), 'order.stage_changed', {
      orderId: order._id,
      stageIndex: 5,
      stageTitle: 'Delivered and confirmed',
      progressPercent: 100,
    });
    void notifyUser(userId, {
      event: 'order.delivered',
      title: `Order ${order.reference} delivered`,
      body: 'Escrow has been released to the seller.',
      target: { type: 'order', id: order._id },
    });
    return updated;
  },

  documentsFor(order: IOrder) {
    return order.documents.map((d) => ({ ...d, available: order.stageIndex >= d.availableFromStage }));
  },

  async documentForDownload(orderId: string, userId: string, documentId: string, client: ApiClient) {
    const order = await this.getForUser(orderId, userId, client);
    const doc = order.documents.find((d) => d._id === documentId);
    if (!doc) throw notFound('document/not-found', 'Document not found');
    if (order.stageIndex < doc.availableFromStage) {
      throw forbidden('document/not-available', 'This document is not available yet.');
    }
    return { order, doc };
  },

  isParty: (order: IOrder, userId: string) => order.userId === userId,
};
