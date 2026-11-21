import { now } from '../../common/utils/clock.js';
import { conflict, unprocessable } from '../../common/errors/app-error.js';
import { OrderModel, type IOrder } from '../../models/order.model.js';
import { notifyUser } from '../notifications/notifications.service.js';
import { enqueueOutbox } from '../outbox/outbox.service.js';
import { uploadsService } from '../uploads/uploads.service.js';
import { assertOrderVersion, loadOwnedOrder, loadOrderByRef } from './v2.order-helpers.js';
import { v2OrdersService } from './v2.orders.service.js';

export const v2ChangesService = {
  /** Admin opens a changes hold (AORD-07 / AORD-17). */
  async requestChanges(input: {
    ref: string;
    scope: 'submission' | 'seller_form';
    note: string;
    flaggedFileIds?: string[];
    version: number;
    staff: { id: string; name: string };
  }) {
    const order = await loadOrderByRef(input.ref);
    assertOrderVersion(order, input.version);
    if (order.hold?.type) throw conflict('order/on-hold', `Order already on hold: ${order.hold.type}`);

    const actor = { kind: 'staff' as const, id: input.staff.id, name: input.staff.name, role: 'ops' };
    const updated = await OrderModel.findOneAndUpdate(
      { _id: order._id, version: order.version },
      {
        $set: {
          hold: {
            type: 'changes',
            owner: 'customer',
            role: 'ops',
            reason: input.note,
            openedAt: now(),
            openedBy: actor,
          },
          pendingChanges: {
            scope: input.scope,
            flaggedFileIds: input.flaggedFileIds ?? [],
            note: input.note,
            requestedAt: now(),
            requestedBy: actor,
          },
        },
        $push: {
          timeline: {
            stepKey: order.workflow?.stepKey ?? 'reviewed',
            label: 'Changes requested',
            actor,
            note: input.note,
            at: now(),
            data: { scope: input.scope },
          },
        },
        $inc: { version: 1 },
      },
      { new: true },
    ).lean<IOrder>();
    if (!updated) throw conflict('step/version', 'Order was updated elsewhere.');

    await notifyUser(order.userId, {
      event: 'order.changes_requested',
      title: `Action needed on ${order.reference}`,
      body: input.note.slice(0, 160),
      target: { type: 'order', id: order._id },
    });
    return v2OrdersService.get(order.userId, order.reference);
  },

  /** Customer submits ORD-17. */
  async submit(input: {
    userId: string;
    ref: string;
    photoFileIds?: string[];
    documentFileIds?: string[];
    replaceFiles?: Record<string, string>;
    note: string;
    version: number;
    sellerForm?: Record<string, unknown>;
  }) {
    const order = await loadOwnedOrder(input.userId, input.ref);
    assertOrderVersion(order, input.version);
    if (order.hold?.type !== 'changes') throw conflict('order/no-changes-hold', 'No open changes request on this order.');

    const scope = order.pendingChanges?.scope ?? 'submission';
    const fileIds = [
      ...(input.photoFileIds ?? []),
      ...(input.documentFileIds ?? []),
      ...Object.values(input.replaceFiles ?? {}),
    ];
    if (fileIds.length) await uploadsService.ownedMany(input.userId, fileIds);

    const actor = { kind: 'customer' as const, id: input.userId };

    if (scope === 'seller_form') {
      if (!input.sellerForm) throw unprocessable('sellerForm required for this change scope', { sellerForm: 'required' });
      const updated = await OrderModel.findOneAndUpdate(
        { _id: order._id, version: order.version },
        {
          $unset: { hold: 1, pendingChanges: 1 },
          $set: {
            sellerForm: input.sellerForm,
            ...(order.workflow?.stepKey === 'form'
              ? {}
              : {}),
          },
          $push: {
            timeline: {
              stepKey: order.workflow?.stepKey ?? 'form',
              label: 'Changes submitted (seller form)',
              actor,
              note: input.note,
              at: now(),
            },
          },
          $inc: { version: 1 },
        },
        { new: true },
      ).lean<IOrder>();
      if (!updated) throw conflict('step/version', 'Order was updated elsewhere.');
      await enqueueOutbox('notify.staff', { action: 'ops', event: 'order.changes_submitted', orderRef: order.reference });
      return v2OrdersService.get(input.userId, order.reference);
    }

    const sellPatch: Record<string, unknown> = {};
    if (input.photoFileIds?.length) sellPatch['sell.photoFileIds'] = input.photoFileIds;
    if (input.documentFileIds?.length) sellPatch['sell.documentFileIds'] = input.documentFileIds;
    if (input.replaceFiles) {
      const photos = [...(order.sell?.photoFileIds ?? [])];
      const docs = [...(order.sell?.documentFileIds ?? [])];
      for (const [oldId, newId] of Object.entries(input.replaceFiles)) {
        const pi = photos.indexOf(oldId);
        if (pi >= 0) photos[pi] = newId;
        const di = docs.indexOf(oldId);
        if (di >= 0) docs[di] = newId;
      }
      sellPatch['sell.photoFileIds'] = photos;
      sellPatch['sell.documentFileIds'] = docs;
    }

    const updated = await OrderModel.findOneAndUpdate(
      { _id: order._id, version: order.version },
      {
        $set: sellPatch,
        $unset: { hold: 1, pendingChanges: 1 },
        $push: {
          timeline: {
            stepKey: order.workflow?.stepKey ?? 'reviewed',
            label: 'Changes submitted',
            actor,
            note: input.note,
            at: now(),
            data: { replaceFiles: input.replaceFiles },
          },
        },
        $inc: { version: 1 },
      },
      { new: true },
    ).lean<IOrder>();
    if (!updated) throw conflict('step/version', 'Order was updated elsewhere.');

    await enqueueOutbox('notify.staff', { action: 'ops', event: 'order.changes_submitted', orderRef: order.reference });
    return v2OrdersService.get(input.userId, order.reference);
  },
};
