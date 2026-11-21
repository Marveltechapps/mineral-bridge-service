import { now } from '../../common/utils/clock.js';
import { opaqueId } from '../../common/utils/ids.js';
import { conflict } from '../../common/errors/app-error.js';
import { OrderModel } from '../../models/order.model.js';
import { notifyUser } from '../notifications/notifications.service.js';
import { loadOrderByRef, loadOwnedOrder } from './v2.order-helpers.js';

export const v2NegotiationService = {
  async get(ref: string) {
    const order = await loadOrderByRef(ref);
    const messages = order.negotiation?.messages ?? [];
    return {
      messages: messages.map((m) => ({
        id: m._id,
        from: m.from,
        who: m.who,
        text: m.text ?? null,
        offer: m.offerMinor != null ? { amountMinor: m.offerMinor, currency: m.currency ?? 'USD', scale: 2 } : null,
        at: m.at instanceof Date ? m.at.toISOString() : m.at,
      })),
      counterOffersOpen: !order.negotiation?.closed && order.workflow?.stepKey !== 'confirmed' && order.status !== 'completed',
    };
  },

  async postStaff(input: {
    ref: string;
    text?: string;
    offerMinor?: number;
    staff: { id: string; name: string };
  }) {
    if (!input.text && input.offerMinor == null) {
      throw conflict('negotiation/empty', 'Write a message or enter a counter-offer');
    }
    const order = await loadOrderByRef(input.ref);
    if (order.negotiation?.closed || order.workflow?.stepKey === 'confirmed') {
      throw conflict('negotiation/closed', 'Negotiation is closed after confirmation.');
    }
    const msg = {
      _id: opaqueId('nmsg'),
      from: 'staff' as const,
      who: input.staff.name,
      text: input.text,
      offerMinor: input.offerMinor,
      currency: (order.pricing?.lockedTotal ?? order.total).currency,
      at: now(),
    };
    await OrderModel.updateOne(
      { _id: order._id },
      {
        $push: { 'negotiation.messages': msg },
        $inc: { version: 1 },
      },
    );
    await notifyUser(order.userId, {
      event: 'negotiation.offer',
      title: `Update on ${order.reference}`,
      body: input.text?.slice(0, 120) ?? `Counter-offer $${((input.offerMinor ?? 0) / 100).toFixed(2)}`,
      target: { type: 'order', id: order._id },
    });
    return this.get(input.ref);
  },

  async postCustomer(input: { userId: string; ref: string; text?: string; offerMinor?: number }) {
    if (!input.text && input.offerMinor == null) {
      throw conflict('negotiation/empty', 'Write a message or enter a counter-offer');
    }
    const order = await loadOwnedOrder(input.userId, input.ref);
    if (order.negotiation?.closed) throw conflict('negotiation/closed', 'Negotiation is closed.');
    const msg = {
      _id: opaqueId('nmsg'),
      from: 'customer' as const,
      who: 'Customer',
      text: input.text,
      offerMinor: input.offerMinor,
      currency: (order.pricing?.lockedTotal ?? order.total).currency,
      at: now(),
    };
    await OrderModel.updateOne({ _id: order._id }, { $push: { 'negotiation.messages': msg }, $inc: { version: 1 } });
    return msg;
  },
};
