import { now } from '../../common/utils/clock.js';
import { opaqueId } from '../../common/utils/ids.js';
import { conflict, notFound, unprocessable } from '../../common/errors/app-error.js';
import { OrderModel, type IOrder } from '../../models/order.model.js';
import { SellerPayoutModel } from '../../models/workflow.model.js';
import { notifyUser } from '../notifications/notifications.service.js';
import { enqueueOutbox } from '../outbox/outbox.service.js';
import { assertOrderVersion, loadOwnedOrder, loadOrderByRef } from './v2.order-helpers.js';
import { v2OrdersService } from './v2.orders.service.js';

export const v2VariationService = {
  async propose(input: {
    ref: string;
    newTotalMinor: number;
    reason: 'qty' | 'grade' | 'both' | 'market' | 'other';
    note: string;
    version: number;
    staff: { id: string; name: string };
  }) {
    const order = await loadOrderByRef(input.ref);
    if (order.side !== 'sell') throw conflict('variation/buy-order', 'Price variation applies to sell orders only.');
    assertOrderVersion(order, input.version);
    if (input.newTotalMinor <= 0) throw unprocessable('newTotalMinor must be positive', { newTotalMinor: 'invalid' });

    const payout = await SellerPayoutModel.findOne({ orderId: order._id, status: 'released' }).lean();
    if (payout) throw conflict('variation/payout-released', 'Cannot vary price after payout release.');

    const from = order.pricing?.lockedTotal ?? order.total;
    const variation = {
      _id: opaqueId('pvr'),
      from,
      to: { amountMinor: input.newTotalMinor, currency: from.currency, scale: from.scale ?? 2 },
      reason: input.reason,
      note: input.note,
      status: 'awaiting_seller' as const,
      proposedBy: { kind: 'staff' as const, id: input.staff.id, name: input.staff.name, role: 'trading' },
      proposedAt: now(),
    };

    const updated = await OrderModel.findOneAndUpdate(
      { _id: order._id, version: order.version },
      {
        $push: {
          priceVariations: variation,
          timeline: {
            stepKey: order.workflow?.stepKey ?? 'confirmed',
            label: 'Price variation proposed',
            actor: variation.proposedBy,
            note: input.note,
            at: now(),
            data: { variationId: variation._id, from: from.amountMinor, to: input.newTotalMinor },
          },
        },
        $inc: { version: 1 },
      },
      { new: true },
    ).lean<IOrder>();
    if (!updated) throw conflict('step/version', 'Order was updated elsewhere.');

    await notifyUser(order.userId, {
      event: 'price_variation.proposed',
      title: `Price update on ${order.reference}`,
      body: input.note.slice(0, 160),
      target: { type: 'order', id: order._id },
      data: { variationId: variation._id },
    });

    return {
      variation,
      unitPrice: input.newTotalMinor,
      declared: order.sell?.declaredValue ?? null,
      certified: order.assay ?? null,
      fairValue: null,
      order: await v2OrdersService.get(order.userId, order.reference),
    };
  },

  async respond(input: {
    userId: string;
    ref: string;
    variationId: string;
    decision: 'accept' | 'reject';
    note?: string;
    version: number;
  }) {
    const order = await loadOwnedOrder(input.userId, input.ref);
    assertOrderVersion(order, input.version);
    const variation = (order.priceVariations ?? []).find((v) => v._id === input.variationId);
    if (!variation) throw notFound('variation/not-found', 'Price variation not found');
    if (variation.status !== 'awaiting_seller') throw conflict('variation/closed', 'Variation is no longer awaiting a response.');

    const payout = await SellerPayoutModel.findOne({ orderId: order._id, status: 'released' }).lean();
    if (payout) throw conflict('variation/payout-released', 'Cannot decide after payout release.');

    const actor = { kind: 'customer' as const, id: input.userId };
    if (input.decision === 'accept') {
      const updated = await OrderModel.findOneAndUpdate(
        { _id: order._id, version: order.version, 'priceVariations._id': variation._id },
        {
          $set: {
            'pricing.lockedTotal': variation.to,
            'pricing.lockedAt': now(),
            total: variation.to,
            'priceVariations.$.status': 'accepted',
            'priceVariations.$.decidedAt': now(),
            'priceVariations.$.decidedBy': actor,
            'priceVariations.$.decisionNote': input.note,
          },
          $push: {
            timeline: {
              stepKey: order.workflow?.stepKey ?? 'confirmed',
              label: 'Price variation accepted',
              actor,
              note: input.note,
              at: now(),
              data: { variationId: variation._id },
            },
          },
          $inc: { version: 1 },
        },
        { new: true },
      ).lean<IOrder>();
      if (!updated) throw conflict('step/version', 'Order was updated elsewhere.');

      await SellerPayoutModel.updateOne(
        { orderId: order._id, status: { $in: ['pending_approval', 'approved'] } },
        { $set: { amount: variation.to } },
      );
      await enqueueOutbox('notify.staff', { action: 'trading', event: 'price_variation.accepted', orderRef: order.reference });
      return v2OrdersService.get(input.userId, order.reference);
    }

    const updated = await OrderModel.findOneAndUpdate(
      { _id: order._id, version: order.version, 'priceVariations._id': variation._id },
      {
        $set: {
          'priceVariations.$.status': 'rejected',
          'priceVariations.$.decidedAt': now(),
          'priceVariations.$.decidedBy': actor,
          'priceVariations.$.decisionNote': input.note,
          hold: {
            type: 'clarify',
            owner: 'platform',
            role: 'trading',
            reason: input.note ?? 'Price variation rejected',
            openedAt: now(),
            openedBy: actor,
          },
        },
        $push: {
          timeline: {
            stepKey: order.workflow?.stepKey ?? 'confirmed',
            label: 'Price variation rejected',
            actor,
            note: input.note,
            at: now(),
            data: { variationId: variation._id },
          },
        },
        $inc: { version: 1 },
      },
      { new: true },
    ).lean<IOrder>();
    if (!updated) throw conflict('step/version', 'Order was updated elsewhere.');
    await enqueueOutbox('notify.staff', { action: 'trading', event: 'price_variation.rejected', orderRef: order.reference });
    return v2OrdersService.get(input.userId, order.reference);
  },
};
