import { addMs, now } from '../../common/utils/clock.js';
import { conflict, forbidden, notFound, unprocessable } from '../../common/errors/app-error.js';
import { idempotencyScope, runIdempotent } from '../../common/idempotency/idempotency.js';
import { references } from '../../common/utils/references.js';
import { OrderModel, type IOrder } from '../../models/order.model.js';
import { PaymentModel, RefundModel, type IRefund, type RefundReason, type RefundStatus } from '../../models/workflow.model.js';
import { notifyUser } from '../notifications/notifications.service.js';
import { enqueueOutbox } from '../outbox/outbox.service.js';
import { loadOwnedOrder, loadOrderByRef } from '../orders/v2.order-helpers.js';
import { v2DocumentsService } from '../documents/v2.documents.service.js';

const OPEN: RefundStatus[] = ['requested', 'review', 'approved', 'processing'];
const REFUND_SLA_DAYS = 5;
const refundApproverMinor = () => Number(process.env.REFUND_APPROVER_MINOR ?? 500_000);

const REASON_MAP: Record<string, RefundReason> = {
  delivery_delayed: 'delivery_delayed',
  quantity_quality: 'quantity_quality',
  damaged: 'damaged',
  damaged_in_transit: 'damaged',
  paid_twice: 'paid_twice',
  no_longer_needed: 'no_longer_needed',
  other: 'other',
};

function money(amountMinor: number, currency = 'USD') {
  return { amountMinor, currency, scale: 2 };
}

function refundDto(r: IRefund, unmask = false) {
  const dest = { ...r.destination };
  if (!unmask) {
    delete (dest as { accountEnc?: string }).accountEnc;
    delete (dest as { upiId?: string }).upiId;
    delete (dest as { btcAddress?: string }).btcAddress;
  }
  return {
    ref: r.reference,
    id: r._id,
    orderId: r.orderId,
    type: r.type,
    amount: r.amount,
    reason: r.reason,
    note: r.note,
    status: r.status,
    destination: dest,
    attachmentFileIds: r.attachmentFileIds,
    cancelOrderOnApproval: r.cancelOrderOnApproval,
    fromDiscrepancy: r.fromDiscrepancy,
    approvals: r.approvals,
    decisions: r.decisions,
    bankRef: r.bankRef,
    refundedAt: r.refundedAt?.toISOString?.() ?? null,
    dueBy: r.dueBy.toISOString(),
    createdAt: r.createdAt.toISOString(),
    overdue: OPEN.includes(r.status) && r.dueBy.getTime() < Date.now(),
  };
}

async function refundableMinor(order: IOrder): Promise<{ refundable: number; currency: string; reason?: string }> {
  if (order.side === 'sell') return { refundable: 0, currency: 'USD', reason: 'sell_order' };
  if (order.source?.kind === 'auction' && order.status === 'cancelled') {
    return { refundable: 0, currency: 'USD', reason: 'auction_no_cancel' };
  }
  if (order.refundSummary?.fullyRefunded) return { refundable: 0, currency: 'USD', reason: 'fully_refunded' };
  const paid = await PaymentModel.findOne({ orderId: order._id, status: 'confirmed' }).lean();
  if (!paid) return { refundable: 0, currency: order.total.currency, reason: 'not_paid' };
  const already = order.refundSummary?.refundedMinor ?? 0;
  const total = paid.amount.amountMinor;
  return { refundable: Math.max(0, total - already), currency: paid.amount.currency };
}

export const v2RefundsService = {
  dto: refundDto,

  async request(input: {
    userId: string;
    ref: string;
    type: 'full' | 'partial';
    amountMinor?: number;
    reason: string;
    note: string;
    destination: IRefund['destination'];
    attachmentFileIds?: string[];
    cancelOrder?: boolean;
    agree: true;
    idempotencyKey: string;
    actor?: { kind: 'customer' | 'staff'; id: string; name?: string };
  }) {
    const order = await loadOwnedOrder(input.userId, input.ref).catch(async () => {
      if (input.actor?.kind === 'staff') return loadOrderByRef(input.ref);
      throw notFound('order/not-found', 'Order not found');
    });
    if (input.actor?.kind !== 'staff' && order.userId !== input.userId) {
      throw forbidden('auth/forbidden', 'Not your order');
    }

    const out = await runIdempotent({
      scope: idempotencyScope(input.userId, `refund:${order._id}`),
      key: input.idempotencyKey,
      body: {
        type: input.type,
        amountMinor: input.amountMinor,
        reason: input.reason,
        note: input.note,
        cancelOrder: input.cancelOrder,
      },
      successStatus: 201,
      fn: async () => {
        const open = await RefundModel.findOne({ orderId: order._id, status: { $in: OPEN } }).lean();
        if (open) throw conflict('refund/in_progress', 'A refund is already in progress for this order.', { details: { reason: 'in_progress' } });

        const { refundable, currency, reason } = await refundableMinor(order);
        if (refundable <= 0) {
          throw conflict('refund/not-refundable', 'This order is not refundable.', { details: { reason: reason ?? 'not_paid' } });
        }

        let amountMinor = input.type === 'full' ? refundable : (input.amountMinor ?? 0);
        if (input.type === 'partial') {
          if (!input.amountMinor || input.amountMinor <= 0) throw unprocessable('Partial refund needs amountMinor', { amountMinor: 'required' });
          if (input.amountMinor >= refundable) throw unprocessable('Partial equals full — use type full', {}, 'refund/partial-equals-full');
          if (input.amountMinor > refundable) throw unprocessable('Amount exceeds refundable', {}, 'refund/amount-exceeds-refundable');
          amountMinor = input.amountMinor;
        }

        const mapped = REASON_MAP[input.reason];
        if (!mapped) throw unprocessable('Invalid refund reason', { reason: 'invalid' });

        const fromDiscrepancy = order.hold?.type === 'discrepancy';
        const doc = await RefundModel.create({
          reference: await references.refund(),
          orderId: order._id,
          userId: order.userId,
          type: input.type,
          amount: money(amountMinor, currency),
          reason: mapped,
          note: input.note,
          attachmentFileIds: input.attachmentFileIds ?? [],
          destination: input.destination,
          fromDiscrepancy,
          cancelOrderOnApproval: Boolean(input.cancelOrder),
          status: 'requested',
          decisions: [
            {
              action: 'requested',
              by: input.actor ?? { kind: 'customer', id: input.userId },
              at: now(),
            },
          ],
          approvals: [],
          dueBy: addMs(now(), REFUND_SLA_DAYS * 86_400_000),
        });

        await OrderModel.updateOne(
          { _id: order._id },
          {
            $set: {
              hold: {
                type: 'refund',
                owner: 'platform',
                role: 'finance',
                reason: `Refund ${doc.reference}`,
                openedAt: now(),
                openedBy: input.actor ?? { kind: 'customer', id: input.userId },
              },
            },
            $addToSet: { 'links.refundIds': doc._id },
            $push: {
              timeline: {
                stepKey: order.workflow?.stepKey ?? 'refund',
                label: 'Refund requested',
                actor: input.actor ?? { kind: 'customer', id: input.userId },
                note: input.note,
                at: now(),
                data: { refundRef: doc.reference },
              },
            },
            $inc: { version: 1 },
          },
        );

        await notifyUser(order.userId, {
          event: 'refund.requested',
          title: `Refund requested · ${doc.reference}`,
          body: `$${ (amountMinor / 100).toFixed(2) } is under review.`,
          target: { type: 'refund', id: doc._id },
          data: { orderRef: order.reference, refundRef: doc.reference },
        });
        await enqueueOutbox('notify.staff', {
          action: 'finance',
          event: 'refund.requested',
          refundRef: doc.reference,
          orderRef: order.reference,
        });

        return { refund: refundDto(doc.toObject() as IRefund) };
      },
    });

    return { ...out.result, replayed: out.replayed };
  },

  async listForUser(userId: string, status: string | undefined, skip: number, limit: number) {
    const filter: Record<string, unknown> = { userId };
    if (status) filter.status = status;
    const [rows, total] = await Promise.all([
      RefundModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean<IRefund[]>(),
      RefundModel.countDocuments(filter),
    ]);
    return {
      items: rows.map((r) => refundDto(r)),
      nextCursor: skip + rows.length < total ? String(skip + rows.length) : null,
      total,
    };
  },

  async getForUser(userId: string, ref: string) {
    const r =
      (await RefundModel.findOne({ reference: ref, userId }).lean<IRefund>()) ??
      (await RefundModel.findOne({ _id: ref, userId }).lean<IRefund>());
    if (!r) throw notFound('refund/not-found', 'Refund not found');
    return refundDto(r);
  },

  async adminList(q: { status?: string; search?: string; skip?: number; limit?: number }) {
    const filter: Record<string, unknown> = {};
    if (q.status === 'overdue') {
      filter.status = { $in: OPEN };
      filter.dueBy = { $lt: now() };
    } else if (q.status) filter.status = q.status;
    if (q.search) {
      filter.$or = [{ reference: new RegExp(q.search, 'i') }, { orderId: q.search }, { note: new RegExp(q.search, 'i') }];
    }
    const skip = q.skip ?? 0;
    const limit = q.limit ?? 50;
    const [rows, total, counts] = await Promise.all([
      RefundModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean<IRefund[]>(),
      RefundModel.countDocuments(filter),
      RefundModel.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    ]);
    return {
      items: rows.map((r) => refundDto(r)),
      total,
      counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
    };
  },

  async adminGet(ref: string, unmask: boolean) {
    const r =
      (await RefundModel.findOne({ reference: ref }).lean<IRefund>()) ??
      (await RefundModel.findById(ref).lean<IRefund>());
    if (!r) throw notFound('refund/not-found', 'Refund not found');
    return refundDto(r, unmask);
  },

  async transition(input: {
    ref: string;
    action: 'review' | 'approve' | 'decline' | 'processing' | 'complete';
    staff: { id: string; publicId?: string; name: string };
    reason?: string;
    bankRef?: string;
    version?: number;
  }) {
    const r =
      (await RefundModel.findOne({ reference: input.ref }).lean<IRefund>()) ??
      (await RefundModel.findById(input.ref).lean<IRefund>());
    if (!r) throw notFound('refund/not-found', 'Refund not found');
    const staffId = input.staff.publicId ?? input.staff.id;
    const actor = { kind: 'staff' as const, id: staffId, name: input.staff.name, role: 'finance' };

    if (input.action === 'review') {
      if (r.status !== 'requested') throw conflict('refund/invalid-status', `Cannot review from ${r.status}`);
      await RefundModel.updateOne(
        { _id: r._id, status: 'requested' },
        { $set: { status: 'review' }, $push: { decisions: { action: 'review', by: actor, at: now() } } },
      );
    } else if (input.action === 'approve') {
      if (r.status !== 'review' && r.status !== 'approved') throw conflict('refund/invalid-status', `Cannot approve from ${r.status}`);
      if (r.approvals.some((a) => a.staffId === staffId)) {
        throw conflict('refund/already-approved', 'You already approved this refund.');
      }
      if (r.approvals.length > 0 && r.approvals[0]!.staffId === staffId) {
        throw forbidden('auth/four-eyes', 'A different finance approver must sign.');
      }
      const approvals = [...r.approvals, { staffId, at: now() }];
      const needTwo = r.amount.amountMinor > refundApproverMinor();
      const enough = needTwo ? approvals.length >= 2 : approvals.length >= 1;
      if (needTwo && approvals.length === 1) {
        await RefundModel.updateOne(
          { _id: r._id },
          {
            $set: { approvals },
            $push: { decisions: { action: 'approve_pending', by: actor, at: now(), reason: '1 of 2' } },
          },
        );
      } else if (enough) {
        await RefundModel.updateOne(
          { _id: r._id },
          {
            $set: { status: 'approved', approvals },
            $push: { decisions: { action: 'approve', by: actor, at: now() } },
          },
        );
      }
    } else if (input.action === 'decline') {
      if (!['requested', 'review'].includes(r.status)) throw conflict('refund/invalid-status', `Cannot decline from ${r.status}`);
      await RefundModel.updateOne(
        { _id: r._id },
        {
          $set: { status: 'declined' },
          $push: { decisions: { action: 'decline', by: actor, at: now(), reason: input.reason } },
        },
      );
      const order = await OrderModel.findById(r.orderId);
      if (order) {
        if (r.fromDiscrepancy) {
          await OrderModel.updateOne(
            { _id: order._id },
            {
              $set: {
                hold: {
                  type: 'discrepancy',
                  owner: 'platform',
                  role: 'ops',
                  reason: input.reason ?? 'Refund declined',
                  openedAt: now(),
                  openedBy: actor,
                },
              },
              $inc: { version: 1 },
            },
          );
        } else {
          await OrderModel.updateOne({ _id: order._id }, { $unset: { hold: 1 }, $inc: { version: 1 } });
        }
      }
    } else if (input.action === 'processing') {
      if (r.status !== 'approved') throw conflict('refund/invalid-status', `Cannot process from ${r.status}`);
      await RefundModel.updateOne(
        { _id: r._id, status: 'approved' },
        { $set: { status: 'processing' }, $push: { decisions: { action: 'processing', by: actor, at: now() } } },
      );
    } else if (input.action === 'complete') {
      if (r.status !== 'processing') throw conflict('refund/invalid-status', `Cannot complete from ${r.status}`);
      if (!input.bankRef?.trim()) throw unprocessable('bankRef required to complete refund', { bankRef: 'required' });
      const updated = await RefundModel.findOneAndUpdate(
        { _id: r._id, status: 'processing' },
        {
          $set: { status: 'refunded', bankRef: input.bankRef, refundedAt: now() },
          $push: { decisions: { action: 'complete', by: actor, at: now(), reason: input.bankRef } },
        },
        { new: true },
      ).lean<IRefund>();
      if (!updated) throw conflict('refund/concurrent', 'Refund status changed');

      const order = await OrderModel.findById(r.orderId).lean<IOrder>();
      if (order) {
        const refundedMinor = (order.refundSummary?.refundedMinor ?? 0) + r.amount.amountMinor;
        const paid = await PaymentModel.findOne({ orderId: order._id, status: 'confirmed' }).lean();
        const fully = paid ? refundedMinor >= paid.amount.amountMinor : true;
        const $set: Record<string, unknown> = {
          refundSummary: { refundedMinor, fullyRefunded: fully },
          'settlement.status': fully ? 'refunded' : order.settlement?.status,
          'settlement.refundedAt': fully ? now() : undefined,
        };
        if (r.cancelOrderOnApproval || fully) {
          $set.status = 'cancelled';
          $set.cancellation = { reason: 'refund', note: `Refund ${r.reference}`, at: now(), by: actor };
        }
        await OrderModel.updateOne(
          { _id: order._id },
          { $set, $unset: { hold: 1 }, $inc: { version: 1 } },
        );
        await v2DocumentsService.issueFromOrder({
          orderId: order._id,
          type: 'refund_receipt',
          userId: order.userId,
          actor,
          data: {
            refundRef: r.reference,
            bankRef: input.bankRef,
            amount: r.amount,
            orderRef: order.reference,
          },
        });
      }
      await notifyUser(r.userId, {
        event: 'refund.completed',
        title: `Refund completed · ${r.reference}`,
        body: 'Funds have been returned to your destination.',
        target: { type: 'refund', id: r._id },
      });
    }

    return this.adminGet(input.ref, false);
  },

  async patch(ref: string, patch: { amountMinor?: number; reason?: string; note?: string }, staff: { id: string; name: string }) {
    const r =
      (await RefundModel.findOne({ reference: ref }).lean<IRefund>()) ??
      (await RefundModel.findById(ref).lean<IRefund>());
    if (!r) throw notFound('refund/not-found', 'Refund not found');
    if (!['requested', 'review'].includes(r.status)) throw conflict('refund/locked', 'Refund can only be edited while requested|review');
    const $set: Record<string, unknown> = {};
    if (patch.amountMinor != null) $set.amount = money(patch.amountMinor, r.amount.currency);
    if (patch.reason) {
      const mapped = REASON_MAP[patch.reason];
      if (!mapped) throw unprocessable('Invalid reason', { reason: 'invalid' });
      $set.reason = mapped;
    }
    if (patch.note) $set.note = patch.note;
    await RefundModel.updateOne(
      { _id: r._id },
      {
        $set,
        $push: {
          decisions: {
            action: 'edit',
            by: { kind: 'staff', id: staff.id, name: staff.name },
            at: now(),
          },
        },
      },
    );
    return this.adminGet(ref, false);
  },
};
