import { now } from '../../../common/utils/clock.js';
import { conflict, forbidden, notFound, unprocessable } from '../../../common/errors/app-error.js';
import { OrderModel, type IOrder } from '../../../models/order.model.js';
import { SellerPayoutModel, type ISellerPayout } from '../../../models/workflow.model.js';
import { notifyUser } from '../../notifications/notifications.service.js';
import { enqueueOutbox } from '../../outbox/outbox.service.js';
import { casAdvanceOrder, loadOrderByRef } from '../../orders/v2.order-helpers.js';
import { v2DocumentsService } from '../../documents/v2.documents.service.js';

const payoutApproverMinor = () => Number(process.env.PAYOUT_APPROVER_MINOR ?? 500_000);

function dto(p: ISellerPayout, order?: IOrder | null) {
  return {
    id: p._id,
    orderRef: order?.reference ?? p.orderId,
    seller: p.userId,
    amount: p.amount,
    to: p.destination.display,
    approvals: p.approvals,
    status: p.status,
    reference: p.releasedRef ?? null,
    failure: p.failure ?? null,
    createdAt: p.createdAt.toISOString(),
  };
}

export const adminPayoutsService = {
  async list(status?: string) {
    const filter = status ? { status } : {};
    const rows = await SellerPayoutModel.find(filter).sort({ createdAt: -1 }).limit(100).lean<ISellerPayout[]>();
    const orderIds = rows.map((r) => r.orderId);
    const orders = await OrderModel.find({ _id: { $in: orderIds } }).lean<IOrder[]>();
    const byId = new Map(orders.map((o) => [o._id, o]));
    return { items: rows.map((r) => dto(r, byId.get(r.orderId))) };
  },

  async ensureForOrder(order: IOrder, destination: ISellerPayout['destination']) {
    const existing = await SellerPayoutModel.findOne({ orderId: order._id }).lean<ISellerPayout>();
    if (existing) return existing;
    const amount = order.pricing?.lockedTotal ?? order.total;
    const doc = await SellerPayoutModel.create({
      orderId: order._id,
      userId: order.userId,
      amount,
      destination,
      status: 'pending_approval',
      approvals: [],
    });
    await OrderModel.updateOne({ _id: order._id }, { $set: { 'links.payoutId': doc._id } });
    return doc.toObject() as ISellerPayout;
  },

  async approve(id: string, staff: { id: string; publicId?: string; name: string }) {
    const p = await SellerPayoutModel.findById(id).lean<ISellerPayout>();
    if (!p) throw notFound('payout/not-found', 'Payout not found');
    if (!['pending_approval', 'approved'].includes(p.status)) {
      throw conflict('payout/invalid-status', `Cannot approve from ${p.status}`);
    }
    const staffId = staff.publicId ?? staff.id;
    if (p.approvals.some((a) => a.staffId === staffId)) {
      throw conflict('payout/already-approved', 'You already approved this payout.');
    }
    if (p.approvals.length > 0 && p.approvals.some((a) => a.staffId === staffId)) {
      throw forbidden('auth/four-eyes', 'A different finance approver must sign.');
    }
    // four-eyes: second approver must differ from first
    if (p.approvals[0] && p.approvals[0].staffId === staffId) {
      throw forbidden('auth/four-eyes', 'A different finance approver must sign.');
    }

    const approvals = [...p.approvals, { staffId, at: now() }];
    const needTwo = p.amount.amountMinor > payoutApproverMinor();
    const enough = needTwo ? approvals.length >= 2 : approvals.length >= 1;
    const status = enough ? 'approved' : 'pending_approval';
    await SellerPayoutModel.updateOne({ _id: p._id }, { $set: { approvals, status } });
    return dto((await SellerPayoutModel.findById(p._id).lean<ISellerPayout>())!);
  },

  async release(input: {
    id: string;
    reference: string;
    version: number;
    staff: { id: string; publicId?: string; name: string };
  }) {
    const p = await SellerPayoutModel.findById(input.id).lean<ISellerPayout>();
    if (!p) throw notFound('payout/not-found', 'Payout not found');
    if (p.status !== 'approved') throw conflict('payout/not-approved', 'Payout must be approved before release.');
    const needTwo = p.amount.amountMinor > payoutApproverMinor();
    if (needTwo && p.approvals.length < 2) {
      throw forbidden('auth/four-eyes', 'Two distinct finance approvals are required before release.');
    }
    if (p.approvals.length < 1) {
      throw forbidden('auth/four-eyes', 'At least one finance approval is required.');
    }
    if (!input.reference.trim()) throw unprocessable('Payout bank/reference required', { reference: 'required' });

    const staffId = input.staff.publicId ?? input.staff.id;
    // Releaser should not be the sole initiator when two eyes required
    if (needTwo && p.approvals.length === 1 && p.approvals[0]!.staffId === staffId) {
      throw forbidden('auth/four-eyes', 'A different finance approver must release.');
    }

    const updated = await SellerPayoutModel.findOneAndUpdate(
      { _id: p._id, status: 'approved' },
      {
        $set: {
          status: 'released',
          releasedRef: input.reference,
          releasedAt: now(),
          releasedBy: { kind: 'staff', id: staffId, name: input.staff.name, role: 'finance' },
        },
      },
      { new: true },
    ).lean<ISellerPayout>();
    if (!updated) throw conflict('payout/concurrent', 'Payout changed during release');

    const order = await OrderModel.findById(p.orderId).lean<IOrder>();
    if (order?.workflow?.stepKey === 'payout') {
      await casAdvanceOrder({
        order,
        toKey: 'ship',
        actor: { kind: 'staff', id: staffId, name: input.staff.name, role: 'finance' },
        note: `Payout released ${input.reference}`,
        version: input.version,
        extraSet: { 'settlement.status': 'released', 'settlement.releasedAt': now() },
      }).catch(async () => {
        await OrderModel.updateOne(
          { _id: order._id },
          {
            $set: { 'settlement.status': 'released', 'settlement.releasedAt': now() },
            $inc: { version: 1 },
          },
        );
      });
    } else if (order) {
      await OrderModel.updateOne(
        { _id: order._id },
        {
          $set: { 'settlement.status': 'released', 'settlement.releasedAt': now() },
          $inc: { version: 1 },
        },
      );
    }

    if (order) {
      await v2DocumentsService.issueFromOrder({
        orderId: order._id,
        type: 'payment_advice',
        userId: order.userId,
        actor: { kind: 'staff', id: staffId, name: input.staff.name },
        data: { payoutRef: input.reference, amount: p.amount },
      });
      await notifyUser(order.userId, {
        event: 'payout.released',
        title: `Payout released · ${order.reference}`,
        body: `Reference ${input.reference}`,
        target: { type: 'order', id: order._id },
      });
    }
    await enqueueOutbox('settlement.seller_payout', { payoutId: p._id, reference: input.reference });
    return dto(updated, order);
  },

  async createFromOrderStep(ref: string, destination: ISellerPayout['destination']) {
    const order = await loadOrderByRef(ref);
    return this.ensureForOrder(order, destination);
  },

  async markFailed(id: string, code: string, reason: string) {
    const updated = await SellerPayoutModel.findOneAndUpdate(
      { _id: id, status: { $in: ['approved', 'pending_approval'] } },
      { $set: { status: 'failed', failure: { code, reason } } },
      { new: true },
    ).lean<ISellerPayout>();
    if (!updated) throw notFound('payout/not-found', 'Payout not found or not failurable');
    return dto(updated);
  },
};
