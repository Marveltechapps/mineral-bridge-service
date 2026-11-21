import { conflict, forbidden, notFound, unprocessable } from '../../common/errors/app-error.js';
import { toGrams } from '../../common/utils/quantity.js';
import { references } from '../../common/utils/references.js';
import { CartModel } from '../../models/cart.model.js';
import { ProductModel } from '../../models/catalog.model.js';
import { OrderModel, type IOrder, type IOrderLine, type IOrderWorkflow, type WorkflowOwner } from '../../models/order.model.js';
import { QuotationModel } from '../../models/workflow.model.js';
import { notifyUser } from '../notifications/notifications.service.js';
import { enqueueOutbox } from '../outbox/outbox.service.js';
import { uploadsService } from '../uploads/uploads.service.js';
import { userRepository } from '../users/user.repository.js';
import { hasRole } from '../users/user.service.js';
import { advanceWorkflow, assertCurrent, startWorkflow } from '../workflow/workflow.service.js';
import type { WorkflowDefinitionId } from '../workflow/workflow.definitions.js';

const zeroMoney = (currency = 'USD') => ({
  amountMinor: 0,
  currency,
  display: `${currency} 0.00`,
});

function mapOwner(owner: string): WorkflowOwner {
  if (owner === 'customer') return 'customer';
  if (owner === 'logistics') return 'logistics';
  if (owner === 'inspection' || owner === 'inspector') return 'inspector';
  return 'platform';
}

function toPersistedWorkflow(definition: WorkflowDefinitionId, initialKey: string): IOrderWorkflow {
  const state = startWorkflow(definition, initialKey);
  return {
    definition: state.definition,
    stepKey: state.current.key,
    stepIndex: state.current.index,
    phase: 1,
    owner: mapOwner(state.current.owner),
    enteredAt: state.current.enteredAt,
  };
}

function toOrderDetail(order: IOrder) {
  return {
    id: order._id,
    reference: order.reference,
    kind: order.side === 'sell' ? 'sell' : 'buy',
    status: order.status,
    workflow: order.workflow
      ? {
          definition: order.workflow.definition,
          version: 1,
          current: {
            key: order.workflow.stepKey,
            owner: order.workflow.owner,
            enteredAt: order.workflow.enteredAt?.toISOString?.() ?? order.workflow.enteredAt,
          },
        }
      : null,
    hold: order.hold ?? null,
    lines: order.lines,
    sell: order.sell ?? null,
    delivery: order.delivery ?? null,
    totals: {
      subtotal: order.subtotal,
      platformFee: order.platformFee,
      surcharge: order.surcharge,
      total: order.total,
    },
    timeline: (order.timeline ?? []).map((t) => ({
      ...t,
      at: t.at instanceof Date ? t.at.toISOString() : t.at,
    })),
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    version: order.version,
  };
}

const isoDate = (d: Date | string | undefined | null): string | null =>
  d ? (d instanceof Date ? d.toISOString() : new Date(d).toISOString()) : null;

function toPriceVariation(v: NonNullable<IOrder['priceVariations']>[number]) {
  return {
    id: v._id,
    from: v.from,
    to: v.to,
    status: v.status,
    reason: v.reason,
    note: v.note,
    proposedAt: isoDate(v.proposedAt),
    decidedAt: isoDate(v.decidedAt),
    decisionNote: v.decisionNote ?? null,
  };
}

function toOrderCard(order: IOrder) {
  return {
    reference: order.reference,
    kind: order.side === 'sell' ? 'sell' : 'buy',
    title: order.sell?.name ?? order.lines[0]?.name ?? order.reference,
    status: order.status,
    step: order.workflow?.stepKey ?? null,
    actionNeeded: order.workflow?.owner === 'customer',
    updatedAt: order.updatedAt.toISOString(),
  };
}

async function assertBuyer(userId: string) {
  const user = await userRepository.findById(userId);
  if (!user) throw notFound('user/not-found', 'User not found');
  if (user.accountStatus !== 'active') throw forbidden('account/suspended', 'Account is not active.');
  if (user.kycStatus !== 'verified') throw forbidden('kyc/not-verified', 'Identity check required before trading.');
  if (!hasRole(user.roles, 'buyer')) {
    throw forbidden('auth/role-required', 'Buyer role required.', { details: { required: ['buyer'] } });
  }
  return user;
}

async function assertSeller(userId: string) {
  const user = await userRepository.findById(userId);
  if (!user) throw notFound('user/not-found', 'User not found');
  if (user.accountStatus !== 'active') throw forbidden('account/suspended', 'Account is not active.');
  if (user.kycStatus !== 'verified') throw forbidden('kyc/not-verified', 'Identity check required before trading.');
  if (!hasRole(user.roles, 'seller')) {
    throw forbidden('auth/role-required', 'Seller role required.', { details: { required: ['seller'] } });
  }
  return user;
}

export const v2OrdersService = {
  toOrderDetail,
  toOrderCard,

  async createBuy(input: {
    userId: string;
    fromCart?: boolean;
    items?: Array<{ productRef: string; qty: { value: string | number; unit: string } }>;
    delivery: {
      org: string;
      street: string;
      city: string;
      region?: string;
      country: string;
      contact: string;
      mobile: string;
    };
  }) {
    const user = await assertBuyer(input.userId);
    const lines: IOrderLine[] = [];
    let currency = 'USD';

    if (input.fromCart) {
      const cart = await CartModel.findOne({ userId: input.userId }).lean();
      if (!cart?.items.length) throw unprocessable('Your cart is empty', { cart: 'Empty' }, 'cart/empty');
      for (const item of cart.items) {
        const p = await ProductModel.findById(item.productId).lean();
        if (!p || p.status !== 'active' || item.grams > p.availableGrams) {
          throw conflict('inventory/insufficient', 'A cart item is no longer available in that quantity.', {
            details: { items: [{ productId: item.productId }] },
          });
        }
        currency = p.currency;
        lines.push({
          productId: p._id,
          name: p.name,
          grams: item.grams,
          unitPriceMinorE4PerGram: p.unitPriceMinorE4PerGram,
          lineTotalMinor: Math.round((item.grams * p.unitPriceMinorE4PerGram) / 10_000),
        });
      }
    } else {
      const items = input.items ?? [];
      if (items.length < 1 || items.length > 10) {
        throw unprocessable('Provide 1–10 items.', { items: 'Invalid count' });
      }
      for (const item of items) {
        const p =
          (await ProductModel.findOne({ reference: item.productRef }).lean()) ??
          (await ProductModel.findById(item.productRef).lean());
        if (!p || p.status !== 'active') {
          throw conflict('inventory/insufficient', 'Product unavailable.', {
            details: { items: [{ productRef: item.productRef }] },
          });
        }
        const unit = item.qty.unit;
        const grams =
          unit === 'ct'
            ? toGrams(Number(item.qty.value), 'ct')
            : toGrams(Number(item.qty.value), (unit === 't' ? 't' : unit) as 'g' | 'kg' | 't');
        if (grams > p.availableGrams) {
          throw conflict('inventory/insufficient', 'A cart item is no longer available in that quantity.', {
            details: { items: [{ productRef: item.productRef, available: p.availableGrams }] },
          });
        }
        currency = p.currency;
        lines.push({
          productId: p._id,
          name: p.name,
          grams,
          unitPriceMinorE4PerGram: p.unitPriceMinorE4PerGram,
          lineTotalMinor: Math.round((grams * p.unitPriceMinorE4PerGram) / 10_000),
        });
      }
    }

    const subtotalMinor = lines.reduce((s, l) => s + l.lineTotalMinor, 0);
    const totalGrams = lines.reduce((s, l) => s + l.grams, 0);
    const money = (amountMinor: number) => ({
      amountMinor,
      currency,
      display: `${currency} ${(amountMinor / 100).toFixed(2)}`,
    });
    const workflow = toPersistedWorkflow('buy.v2', 'accepted');
    const at = new Date();
    const order = await OrderModel.create({
      reference: await references.order(),
      userId: input.userId,
      customerNo: user.customerNo,
      side: 'buy',
      status: 'pending_review',
      stageIndex: 0,
      stageHistory: [{ index: 0, key: 'accepted', at }],
      source: { kind: input.fromCart ? 'cart' : 'product' },
      workflow,
      timeline: [
        {
          stepKey: 'accepted',
          label: 'Order placed',
          actor: { kind: 'customer', id: input.userId },
          note: 'Order placed · under review',
          at,
        },
      ],
      lines,
      totalGrams,
      subtotal: money(subtotalMinor),
      platformFee: money(0),
      surcharge: money(0),
      total: money(subtotalMinor),
      paymentMethod: 'escrow',
      paymentTaken: false,
      delivery: {
        org: input.delivery.org,
        streetAddress: input.delivery.street,
        city: input.delivery.city,
        region: input.delivery.region,
        country: input.delivery.country,
        contactPerson: input.delivery.contact,
        contactPhone: input.delivery.mobile,
      },
      settlement: { method: 'escrow', status: 'not_funded' },
      documents: [],
      version: 0,
    });

    // Doc 08 D.5: stock is NOT reserved until desk acceptance.
    if (input.fromCart) {
      await CartModel.updateOne({ userId: input.userId }, { $set: { items: [] }, $inc: { version: 1 } });
    }

    void notifyUser(input.userId, {
      event: 'order.placed',
      title: `Order ${order.reference} placed`,
      body: 'Order placed · under review',
      target: { type: 'order', id: order._id },
    });
    void enqueueOutbox('order.placed', { orderId: order._id, userId: input.userId, reference: order.reference });
    void enqueueOutbox('audit.orders', { action: 'Order placed', actorId: input.userId, orderId: order._id });

    return toOrderDetail(order.toObject() as IOrder);
  },

  async createSell(input: {
    userId: string;
    sell: {
      mineral: string;
      name?: string;
      qty: { value: string | number; unit: string };
      grade: string;
      form: string;
      details: string;
      photoFileIds: string[];
      documentFileIds?: string[];
      /** Staff only: photos received outside the app (email, courier). Replaces the upload count. */
      photosReceived?: number;
    };
  }) {
    const user = await assertSeller(input.userId);
    const { sell } = input;
    const photoCount = Math.max(sell.photoFileIds?.length ?? 0, sell.photosReceived ?? 0);
    if (photoCount < 3) {
      throw unprocessable('Upload at least 3 photos.', { photoFileIds: 'Minimum 3' });
    }
    if (sell.details.trim().length < 10) {
      throw unprocessable('Provide more detail about the material.', { details: 'Min 10 characters' });
    }
    if (sell.photoFileIds?.length) await uploadsService.ownedMany(input.userId, sell.photoFileIds);
    if (sell.documentFileIds?.length) await uploadsService.ownedMany(input.userId, sell.documentFileIds);

    const unit = sell.qty.unit;
    const grams =
      unit === 'ct'
        ? toGrams(Number(sell.qty.value), 'ct')
        : toGrams(Number(sell.qty.value), (unit === 't' ? 't' : unit) as 'g' | 'kg' | 't');
    const workflow = toPersistedWorkflow('sell.v2', 'reviewed');
    const at = new Date();
    const yy = String(new Date().getUTCFullYear()).slice(-2);
    const sellRef = (await references.sellRequest()).replace(/^MB-S-/, `MB-SELL-${yy}-`);
    const order = await OrderModel.create({
      reference: sellRef,
      userId: input.userId,
      customerNo: user.customerNo,
      side: 'sell',
      status: 'pending_review',
      stageIndex: 0,
      stageHistory: [{ index: 0, key: 'reviewed', at }],
      source: { kind: 'sell_request' },
      workflow,
      timeline: [
        {
          stepKey: 'reviewed',
          label: 'Sell request submitted',
          actor: { kind: 'customer', id: input.userId },
          at,
        },
      ],
      lines: [],
      totalGrams: grams,
      sell: {
        mineralSlug: sell.mineral,
        name: sell.name ?? sell.mineral,
        qty: { measure: 'mass', unit: unit === 't' ? 't' : unit, base: grams },
        grade: sell.grade,
        form: sell.form,
        details: sell.details,
        photoFileIds: sell.photoFileIds ?? [],
        ...(sell.photosReceived ? { photosReceived: sell.photosReceived } : {}),
        documentFileIds: sell.documentFileIds ?? [],
      },
      subtotal: zeroMoney(),
      platformFee: zeroMoney(),
      surcharge: zeroMoney(),
      total: zeroMoney(),
      paymentMethod: 'escrow',
      paymentTaken: false,
      settlement: { method: 'escrow', status: 'not_funded' },
      documents: [],
      version: 0,
    });

    void notifyUser(input.userId, {
      event: 'order.submitted',
      title: `Sell request ${order.reference}`,
      body: 'Your sell request is under review.',
      target: { type: 'order', id: order._id },
    });
    void enqueueOutbox('order.submitted', { orderId: order._id, userId: input.userId, reference: order.reference });
    void enqueueOutbox('audit.orders', {
      action: 'Sell request submitted',
      actorId: input.userId,
      orderId: order._id,
    });

    return toOrderDetail(order.toObject() as IOrder);
  },

  async list(input: {
    userId: string;
    kind?: string;
    state?: string;
    actionNeeded?: boolean;
    limit?: number;
    cursor?: string;
  }) {
    const filter: Record<string, unknown> = { userId: input.userId, deletedAt: { $exists: false } };
    if (input.kind === 'buy') filter.side = 'buy';
    if (input.kind === 'sell') filter.side = 'sell';
    if (input.kind === 'auction') filter['source.kind'] = 'auction';
    if (input.actionNeeded) filter['workflow.owner'] = 'customer';
    if (input.state === 'open') filter.status = { $nin: ['completed', 'cancelled', 'rejected'] };
    if (input.state === 'done') filter.status = { $in: ['completed'] };
    if (input.state === 'cancelled') filter.status = { $in: ['cancelled', 'rejected'] };

    const limit = input.limit ?? 20;
    const skip = input.cursor ? Number.parseInt(input.cursor, 10) || 0 : 0;
    const [rows, total] = await Promise.all([
      OrderModel.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean<IOrder[]>(),
      OrderModel.countDocuments(filter),
    ]);
    return {
      items: rows.map(toOrderCard),
      nextCursor: skip + rows.length < total ? String(skip + rows.length) : null,
      total,
    };
  },

  async get(userId: string, ref: string) {
    const order =
      (await OrderModel.findOne({ reference: ref, userId, deletedAt: { $exists: false } }).lean<IOrder>()) ??
      (await OrderModel.findOne({ _id: ref, userId, deletedAt: { $exists: false } }).lean<IOrder>());
    if (!order) throw notFound('order/not-found', 'Order not found');
    const detail = {
      ...toOrderDetail(order),
      priceVariations: (order.priceVariations ?? []).map(toPriceVariation),
    };
    const quotation =
      (await QuotationModel.findOne({ orderId: order._id, status: 'issued' }).lean()) ??
      (await QuotationModel.findOne({ orderId: order._id }).sort({ rev: -1 }).lean());
    if (!quotation) return detail;
    return {
      ...detail,
      quotation: {
        number: quotation.number,
        rev: quotation.rev,
        status: quotation.status,
        lines: quotation.lines,
        fee: quotation.fee,
        transport: quotation.transport,
        other: quotation.other ?? null,
        deduction: quotation.deduction ?? null,
        total: quotation.total,
        validUntil: quotation.validUntil instanceof Date ? quotation.validUntil.toISOString() : quotation.validUntil,
        conditions: quotation.conditions ?? null,
        issuedAt: quotation.issuedAt instanceof Date ? quotation.issuedAt.toISOString() : quotation.issuedAt,
      },
    };
  },

  async acceptQuotation(input: {
    userId: string;
    ref: string;
    quotationNumber: string;
    version: number;
  }) {
    const order = await loadOwned(input.userId, input.ref);
    if (!order.workflow) throw conflict('step/invalid', 'Order has no workflow.');
    if (order.version !== input.version) {
      throw conflict('step/version', 'Order was updated elsewhere. Refresh and retry.', {
        details: { version: order.version },
      });
    }
    assertCurrent(
      {
        definition: order.workflow.definition as WorkflowDefinitionId,
        version: 1,
        current: {
          key: order.workflow.stepKey,
          index: order.workflow.stepIndex,
          owner: order.workflow.owner,
          enteredAt: order.workflow.enteredAt,
        },
        history: [],
      },
      'quoteOk',
    );
    if (order.hold?.type) throw conflict('step/held', 'Order is on hold.');

    const q = await QuotationModel.findOne({
      orderId: order._id,
      number: input.quotationNumber,
      status: 'issued',
    }).lean();
    if (!q) throw conflict('quotation/not-current', 'Quotation is not the current issued quote.');
    if (q.validUntil.getTime() <= Date.now()) {
      const { AppError } = await import('../../common/errors/app-error.js');
      throw new AppError({ status: 410, code: 'quotation/expired', message: 'Quotation has expired.' });
    }

    const now = new Date();
    await QuotationModel.updateOne(
      { _id: q._id },
      {
        $set: {
          status: 'accepted',
          decision: { at: now, by: { kind: 'customer', id: input.userId } },
        },
      },
    );

    const advanced = advanceWorkflow(
      {
        definition: order.workflow.definition as WorkflowDefinitionId,
        version: 1,
        current: {
          key: order.workflow.stepKey,
          index: order.workflow.stepIndex,
          owner: order.workflow.owner,
          enteredAt: order.workflow.enteredAt,
        },
        history: [],
      },
      'confirmed',
      { kind: 'customer', id: input.userId },
      'Quotation accepted',
    );

    const updated = await OrderModel.findOneAndUpdate(
      { _id: order._id, version: input.version },
      {
        $set: {
          workflow: {
            definition: advanced.definition,
            stepKey: advanced.current.key,
            stepIndex: advanced.current.index,
            phase: 2,
            owner: mapOwner(advanced.current.owner),
            enteredAt: advanced.current.enteredAt,
          },
          'pricing.quotationId': q._id,
          'pricing.quotedTotal': q.total,
          status: 'active',
        },
        $push: {
          timeline: {
            stepKey: 'confirmed',
            label: 'Quotation accepted',
            actor: { kind: 'customer', id: input.userId },
            note: `Accepted ${q.number}`,
            at: now,
          },
        },
        $inc: { version: 1 },
      },
      { new: true },
    );
    if (!updated) throw conflict('step/version', 'Order was updated elsewhere. Refresh and retry.');

    void enqueueOutbox('quotation.accepted', { orderId: order._id, quotationId: q._id });
    void enqueueOutbox('audit.orders', { action: 'Quotation accepted', actorId: input.userId, orderId: order._id });
    return this.get(input.userId, order.reference);
  },

  async declineQuotation(input: {
    userId: string;
    ref: string;
    quotationNumber: string;
    version: number;
    reason?: string;
  }) {
    const order = await loadOwned(input.userId, input.ref);
    if (!order.workflow || order.workflow.stepKey !== 'quoteOk') {
      throw conflict('step/invalid', 'Order is not awaiting quotation decision.');
    }
    const q = await QuotationModel.findOne({
      orderId: order._id,
      number: input.quotationNumber,
      status: 'issued',
    }).lean();
    if (!q) throw conflict('quotation/not-current', 'Quotation is not the current issued quote.');

    const now = new Date();
    await QuotationModel.updateOne(
      { _id: q._id },
      {
        $set: {
          status: 'declined',
          decision: { at: now, by: { kind: 'customer', id: input.userId }, reason: input.reason },
        },
      },
    );
    await OrderModel.updateOne(
      { _id: order._id },
      {
        $set: {
          hold: {
            type: 'declined',
            owner: 'trading',
            reason: input.reason,
            openedAt: now,
            openedBy: { kind: 'customer', id: input.userId },
          },
        },
        $push: {
          timeline: {
            stepKey: 'quoteOk',
            label: 'Quotation declined',
            actor: { kind: 'customer', id: input.userId },
            note: input.reason,
            at: now,
          },
        },
        $inc: { version: 1 },
      },
    );
    void enqueueOutbox('quotation.declined', { orderId: order._id, quotationId: q._id });
    void enqueueOutbox('audit.orders', { action: 'Quotation declined', actorId: input.userId, orderId: order._id });
    return this.get(input.userId, order.reference);
  },
};

async function loadOwned(userId: string, ref: string): Promise<IOrder> {
  const order =
    (await OrderModel.findOne({ reference: ref, userId }).lean<IOrder>()) ??
    (await OrderModel.findOne({ _id: ref, userId }).lean<IOrder>());
  if (!order) throw notFound('order/not-found', 'Order not found');
  return order;
}
