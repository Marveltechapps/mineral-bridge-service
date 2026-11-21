import { conflict, notFound, unprocessable } from '../../common/errors/app-error.js';
import { toGrams } from '../../common/utils/quantity.js';
import { OrderModel } from '../../models/order.model.js';
import { ShipmentModel } from '../../models/contract-lc.model.js';
import { InspectionModel } from '../../models/workflow.model.js';
import { enqueueOutbox } from '../outbox/outbox.service.js';
import { notifyUser } from '../notifications/notifications.service.js';
import { uploadsService } from '../uploads/uploads.service.js';
import {
  assertOrderVersion,
  casAdvanceOrder,
  loadOwnedOrder,
  workflowStateFromOrder,
} from './v2.order-helpers.js';
import { assertCurrent } from '../workflow/workflow.service.js';
import { QuotationModel } from '../../models/workflow.model.js';
import { ContractModel } from '../../models/contract-lc.model.js';
import { v2OrdersService } from './v2.orders.service.js';

const BUY_CANCEL_REASONS = [
  'Changed my mind',
  'Found another supplier',
  'Delivery timeline too long',
  'Other',
];

export const v2LifecycleService = {
  async acceptInspection(userId: string, ref: string, version: number) {
    const order = await loadOwnedOrder(userId, ref);
    assertOrderVersion(order, version);
    assertCurrent(workflowStateFromOrder(order), 'reportOk');
    const insp = await InspectionModel.findOne({ orderId: order._id }).sort({ createdAt: -1 });
    if (!insp?.report) throw conflict('inspection/report-missing', 'Inspection report is not available.');
    insp.customerReview = { accepted: true, at: new Date() };
    insp.status = 'accepted';
    await insp.save();
    await casAdvanceOrder({
      order,
      toKey: 'approved',
      actor: { kind: 'customer', id: userId },
      note: 'Inspection reports accepted by seller',
      version,
    });
    void enqueueOutbox('audit.inspections', {
      action: 'Inspection reports accepted by seller',
      actorId: userId,
      orderId: order._id,
    });
    return v2OrdersService.get(userId, order.reference);
  },

  async queryInspection(userId: string, ref: string, note: string, version: number) {
    const order = await loadOwnedOrder(userId, ref);
    assertOrderVersion(order, version);
    assertCurrent(workflowStateFromOrder(order), 'reportOk');
    await InspectionModel.updateOne(
      { orderId: order._id },
      { $set: { 'customerReview.query': note, status: 'queried' } },
    );
    await OrderModel.findOneAndUpdate(
      { _id: order._id, version },
      {
        $set: {
          hold: {
            type: 'clarify',
            owner: 'inspection',
            reason: note,
            openedAt: new Date(),
            openedBy: { kind: 'customer', id: userId },
          },
        },
        $inc: { version: 1 },
      },
    );
    void enqueueOutbox('audit.inspections', { action: 'Clarification requested', actorId: userId, orderId: order._id });
    return v2OrdersService.get(userId, order.reference);
  },

  async acceptDelivery(
    userId: string,
    ref: string,
    body: {
      qtyReceived: { value: string | number; unit: string };
      condition: 'good' | 'minor_damage' | 'damaged';
      photoFileIds: string[];
      note?: string;
      version: number;
    },
  ) {
    const order = await loadOwnedOrder(userId, ref);
    assertOrderVersion(order, body.version);
    assertCurrent(workflowStateFromOrder(order), 'receipt');
    if (!body.photoFileIds?.length) throw unprocessable('Add at least one photo.', { photoFileIds: 'Required' });
    await uploadsService.ownedMany(userId, body.photoFileIds);
    const grams = toGrams(
      Number(body.qtyReceived.value),
      (body.qtyReceived.unit === 't' ? 't' : body.qtyReceived.unit) as 'g' | 'kg' | 't' | 'ct',
    );
    await casAdvanceOrder({
      order,
      toKey: 'done',
      actor: { kind: 'customer', id: userId },
      note: 'Receipt confirmed',
      version: body.version,
      extraSet: {
        status: 'completed',
        deliveryReport: {
          qtyReceived: String(grams),
          condition: body.condition,
          note: body.note,
          photoFileIds: body.photoFileIds,
          outcome: 'accepted',
          at: new Date(),
        },
      },
    });
    void notifyUser(userId, {
      event: 'order.completed',
      title: `Order completed · ${order.reference}`,
      body: 'Thank you for confirming delivery.',
      target: { type: 'order', id: order._id },
    });
    return v2OrdersService.get(userId, order.reference);
  },

  async disputeDelivery(
    userId: string,
    ref: string,
    body: {
      qtyReceived: { value: string | number; unit: string };
      condition: string;
      photoFileIds: string[];
      note: string;
      version: number;
    },
  ) {
    if (!body.note || body.note.trim().length < 5) {
      throw unprocessable('Describe the discrepancy.', { note: 'Min 5 characters' });
    }
    const order = await loadOwnedOrder(userId, ref);
    assertOrderVersion(order, body.version);
    assertCurrent(workflowStateFromOrder(order), 'receipt');
    await uploadsService.ownedMany(userId, body.photoFileIds);
    await OrderModel.findOneAndUpdate(
      { _id: order._id, version: body.version },
      {
        $set: {
          hold: {
            type: 'discrepancy',
            owner: 'ops',
            reason: body.note,
            openedAt: new Date(),
            openedBy: { kind: 'customer', id: userId },
          },
          deliveryReport: {
            qtyReceived: String(body.qtyReceived.value),
            condition: body.condition,
            note: body.note,
            photoFileIds: body.photoFileIds,
            outcome: 'disputed',
            at: new Date(),
          },
        },
        $push: {
          timeline: {
            stepKey: 'receipt',
            label: 'Discrepancy raised',
            actor: { kind: 'customer', id: userId },
            note: body.note,
            at: new Date(),
          },
        },
        $inc: { version: 1 },
      },
    );
    void notifyUser(userId, {
      event: 'order.discrepancy',
      title: 'Discrepancy received',
      body: 'Mineral Bridge will review it within 1 working day.',
      target: { type: 'order', id: order._id },
    });
    return v2OrdersService.get(userId, order.reference);
  },

  async cancellationEligibility(userId: string, ref: string) {
    const order = await loadOwnedOrder(userId, ref);
    const paid = order.paymentTaken || order.settlement?.status === 'held' || order.settlement?.status === 'released';
    let mode: 'free' | 'refund' | 'none' = 'free';
    if (['completed', 'cancelled', 'rejected'].includes(order.status)) mode = 'none';
    else if (paid) mode = 'refund';
    else if (order.workflow && ['payOk', 'assigned', 'picked', 'transit', 'delivered', 'receipt', 'done'].includes(order.workflow.stepKey)) {
      mode = paid ? 'refund' : 'none';
    }
    return {
      mode,
      reasons: BUY_CANCEL_REASONS,
      message:
        mode === 'free'
          ? 'You can cancel without a refund request.'
          : mode === 'refund'
            ? 'Cancellation requires a refund request.'
            : 'This order can no longer be cancelled.',
      paid: paid ? order.pricing?.lockedTotal ?? order.total : null,
    };
  },

  async cancel(
    userId: string,
    ref: string,
    body: { reason: string; note?: string; agree: true; version: number },
  ) {
    const eligibility = await this.cancellationEligibility(userId, ref);
    if (eligibility.mode === 'none') throw conflict('order/not-cancellable', 'Order cannot be cancelled.', { details: { mode: 'none' } });
    if (eligibility.mode === 'refund') {
      throw conflict('order/cancel-requires-refund', 'Open a refund request to cancel.', { details: { mode: 'refund' } });
    }
    if (body.reason === 'Other' && (!body.note || body.note.trim().length < 10)) {
      throw unprocessable('Add a note for Other.', { note: 'Min 10 characters' });
    }
    const order = await loadOwnedOrder(userId, ref);
    assertOrderVersion(order, body.version);
    const now = new Date();
    const updated = await OrderModel.findOneAndUpdate(
      { _id: order._id, version: body.version },
      {
        $set: {
          status: 'cancelled',
          cancellation: { reason: body.reason, note: body.note, at: now, by: { kind: 'customer', id: userId }, refundMinor: 0 },
        },
        $push: {
          timeline: {
            stepKey: order.workflow?.stepKey ?? 'cancelled',
            label: 'Order cancelled by customer',
            actor: { kind: 'customer', id: userId },
            note: body.reason,
            at: now,
          },
        },
        $inc: { version: 1 },
      },
      { new: true },
    );
    if (!updated) throw conflict('step/version', 'Order was updated elsewhere.');
    await QuotationModel.updateMany({ orderId: order._id, status: 'issued' }, { $set: { status: 'replaced' } });
    await ContractModel.updateMany({ orderId: order._id, status: { $ne: 'cancelled' } }, { $set: { status: 'cancelled' } });
    void notifyUser(userId, {
      event: 'order.cancelled',
      title: 'Order cancelled',
      body: `${order.reference} was cancelled.`,
      target: { type: 'order', id: order._id },
    });
    void enqueueOutbox('audit.orders', { action: 'Order cancelled by customer', actorId: userId, orderId: order._id });
    return v2OrdersService.get(userId, order.reference);
  },

  async getShipment(userId: string, ref: string) {
    const order = await loadOwnedOrder(userId, ref);
    const shipmentId = order.links?.shipmentId;
    const shipment = shipmentId
      ? await ShipmentModel.findById(shipmentId).lean()
      : await ShipmentModel.findOne({ orderId: order._id }).lean();
    if (!shipment) throw notFound('shipment/not-assigned', 'Shipment has not been assigned yet.');
    return shipment;
  },

  async sellerForm(
    userId: string,
    ref: string,
    body: {
      payout: Record<string, unknown>;
      inspectionSlot: { date: string; time: string; address: string };
      confirmed: true;
      version: number;
    },
  ) {
    const order = await loadOwnedOrder(userId, ref);
    assertOrderVersion(order, body.version);
    assertCurrent(workflowStateFromOrder(order), 'form');
    await casAdvanceOrder({
      order,
      toKey: 'formOk',
      actor: { kind: 'customer', id: userId },
      note: 'Seller confirmation form submitted',
      version: body.version,
      clearHold: true,
      extraSet: { sellerForm: { payout: body.payout, inspectionSlot: body.inspectionSlot, confirmedAt: new Date() } },
    });
    return v2OrdersService.get(userId, order.reference);
  },
};
