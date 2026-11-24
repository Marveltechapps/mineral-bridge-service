import { conflict, forbidden, unprocessable } from '../../../common/errors/app-error.js';
import { recordAudit } from '../../audit/audit.service.js';
import { consoleStage, LIVE_ORDERS } from './admin-console.service.js';
import { opaqueId } from '../../../common/utils/ids.js';
import { references } from '../../../common/utils/references.js';
import { OrderModel, type IOrder } from '../../../models/order.model.js';
import { QuotationModel, PaymentModel, InspectionModel, SellerPayoutModel, IssuedDocumentModel } from '../../../models/workflow.model.js';
import { ShipmentModel } from '../../../models/contract-lc.model.js';
import { ProductModel } from '../../../models/catalog.model.js';
import { UserModel } from '../../../models/user.model.js';
import { ordersRepository } from '../../orders/orders.repository.js';
import { v2ContractService } from '../../orders/v2.contract.service.js';
import { v2PaymentsService } from '../../orders/v2.payments.service.js';
import {
  assertOrderVersion,
  casAdvanceOrder,
  loadOrderByRef,
  workflowStateFromOrder,
} from '../../orders/v2.order-helpers.js';
import { assertCurrent } from '../../workflow/workflow.service.js';
import { stepDef, type WorkflowDefinitionId } from '../../workflow/workflow.definitions.js';
import { enqueueOutbox } from '../../outbox/outbox.service.js';
import { notifyUser } from '../../notifications/notifications.service.js';
import { userRepository } from '../../users/user.repository.js';

type StaffActor = { id: string; name: string; role?: string; publicId?: string };

function adminOrderCard(order: IOrder, customer?: { name?: string; business?: string; country?: string; no?: string }) {
  return {
    ref: order.reference,
    kind: order.side,
    source: order.source?.kind ?? 'direct',
    customer: {
      no: customer?.no ?? order.customerNo ?? null,
      name: customer?.name ?? null,
      business: customer?.business ?? null,
      country: customer?.country ?? order.delivery?.country ?? null,
    },
    itemsText: order.sell?.name ?? (order.lines.map((l) => l.name).join(' · ') || order.reference),
    step: order.workflow
      ? {
          key: order.workflow.stepKey,
          label: stepDef(order.workflow.definition as WorkflowDefinitionId, order.workflow.stepKey).label,
          owner: order.workflow.owner,
          role: order.workflow.role,
        }
      : null,
    hold: order.hold ?? null,
    status: { label: order.status, tone: order.status === 'completed' ? 'ok' : order.status === 'cancelled' ? 'muted' : 'active' },
    value: order.pricing?.lockedTotal ?? order.total,
    enteredAt: order.workflow?.enteredAt?.toISOString?.() ?? order.updatedAt.toISOString(),
    createdAt: order.createdAt.toISOString(),
  };
}

export const adminV2OrdersService = {
  async list(query: {
    kind?: string;
    queue?: string;
    step?: string;
    customerNo?: string;
    q?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 25, 100);
    const filter: Record<string, unknown> = { ...LIVE_ORDERS };
    if (query.kind === 'buy' || query.kind === 'sell') filter.side = query.kind;
    if (query.step) filter['workflow.stepKey'] = query.step;
    if (query.customerNo) filter.customerNo = query.customerNo;
    if (query.queue === 'needs_platform') filter['workflow.owner'] = { $in: ['platform', 'ops', 'trading', 'finance', 'logistics', 'inspector'] };
    if (query.queue === 'waiting_customer') filter['workflow.owner'] = 'customer';
    if (query.queue === 'on_hold') filter.hold = { $exists: true };
    if (query.queue === 'completed') filter.status = 'completed';
    if (query.queue === 'rejected') filter.status = { $in: ['rejected', 'cancelled'] };
    if (query.q) {
      filter.$or = [
        { reference: new RegExp(query.q, 'i') },
        { customerNo: new RegExp(query.q, 'i') },
        { 'sell.name': new RegExp(query.q, 'i') },
      ];
    }

    const [rows, total, needs, waiting, hold, completed, rejected] = await Promise.all([
      OrderModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean<IOrder[]>(),
      OrderModel.countDocuments(filter),
      OrderModel.countDocuments({ ...LIVE_ORDERS, 'workflow.owner': { $ne: 'customer' }, status: { $nin: ['completed', 'cancelled', 'rejected'] } }),
      OrderModel.countDocuments({ ...LIVE_ORDERS, 'workflow.owner': 'customer', status: { $nin: ['completed', 'cancelled', 'rejected'] } }),
      OrderModel.countDocuments({ ...LIVE_ORDERS, hold: { $exists: true } }),
      OrderModel.countDocuments({ ...LIVE_ORDERS, status: 'completed' }),
      OrderModel.countDocuments({ ...LIVE_ORDERS, status: { $in: ['rejected', 'cancelled'] } }),
    ]);

    const userIds = [...new Set(rows.map((r) => r.userId))];
    const users = await UserModel.find({ _id: { $in: userIds } }).lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));

    return {
      items: rows.map((o) => {
        const u = byId.get(o.userId) as { profile?: { fullName?: string; companyName?: string; countryCode?: string }; customerNo?: string } | undefined;
        return adminOrderCard(o, {
          no: o.customerNo ?? u?.customerNo,
          name: u?.profile?.fullName,
          business: u?.profile?.companyName,
          country: u?.profile?.countryCode,
        });
      }),
      page,
      pageSize,
      total,
      counts: {
        all: total,
        needs_platform: needs,
        waiting_customer: waiting,
        on_hold: hold,
        completed,
        rejected,
      },
    };
  },

  async detail(ref: string) {
    const order = await loadOrderByRef(ref);
    const user = await userRepository.findById(order.userId);
    const quotation = await QuotationModel.findOne({ orderId: order._id }).sort({ rev: -1 }).lean();
    const payment = await PaymentModel.findOne({ orderId: order._id }).sort({ attempt: -1 }).lean();
    const next = order.workflow
      ? {
          key: order.workflow.stepKey,
          label: stepDef(order.workflow.definition as WorkflowDefinitionId, order.workflow.stepKey).label,
          owner: order.workflow.owner,
          role: order.workflow.role,
          enteredAt: order.workflow.enteredAt,
          allowedActions: order.workflow.owner === 'customer' ? [] : [order.workflow.role ?? 'ops'],
        }
      : null;
    return {
      ...order,
      customer: user
        ? {
            no: user.customerNo,
            name: user.profile.fullName,
            business: user.business?.name ?? user.profile.companyName,
            country: user.profile.countryCode,
            email: user.email,
            whatsapp: user.whatsapp ?? user.phone,
            kyc: user.kycStatus,
            accountStatus: user.accountStatus,
          }
        : null,
      next,
      quotation,
      payment,
    };
  },

  async completeStep(input: {
    ref: string;
    stepKey: string;
    version: number;
    data: Record<string, unknown>;
    note?: string;
    staff: StaffActor;
  }) {
    const order = await loadOrderByRef(input.ref);
    assertOrderVersion(order, input.version);
    const wf = workflowStateFromOrder(order);
    const reissueQuote = input.stepKey === 'quote' && wf.current.key === 'quoteOk';
    const reissueAfterDecline = reissueQuote && order.hold?.type === 'declined';
    if (order.hold?.type && !reissueAfterDecline) {
      throw conflict('step/hold', 'Clear the hold before advancing.');
    }
    if (!reissueQuote) assertCurrent(wf, input.stepKey);

    const actor = { kind: 'staff' as const, id: input.staff.id, name: input.staff.name, role: input.staff.role };

    switch (input.stepKey) {
      case 'accepted': {
        // Reserve stock for buy orders. Any failure (a later line short, or a stale version) releases what was taken.
        const reserved: { productId: string; grams: number }[] = [];
        try {
          if (order.side === 'buy') {
            for (const line of order.lines) {
              if (!line.productId) continue;
              const ok = await ordersRepository.reserveStock(line.productId, line.grams);
              if (!ok) throw conflict('inventory/insufficient', 'Not enough stock to reserve.');
              reserved.push({ productId: line.productId, grams: line.grams });
            }
          }
          return await casAdvanceOrder({ order, toKey: 'quote', actor, note: input.note, version: input.version });
        } catch (err) {
          await Promise.all(reserved.map((r) => ordersRepository.restoreStock(r.productId, r.grams)));
          throw err;
        }
      }
      case 'quote': {
        const data = input.data;
        const money = (amountMinor: number, currency = order.total.currency) => ({
          amountMinor,
          currency,
          display: `${currency} ${(amountMinor / 100).toFixed(2)}`,
        });
        let totalMinor = 0;
        const lines: { name: string; qty: unknown; price: ReturnType<typeof money> }[] = [];
        if (order.side === 'buy') {
          const priced = (data.lines as Array<{ productRef: string; amountMinor: number }> | undefined) ?? [];
          if (!priced.length) throw unprocessable('Price every line.', { lines: 'Required' });
          for (const row of priced) {
            const p = await ProductModel.findOne({ $or: [{ reference: row.productRef }, { _id: row.productRef }] }).lean();
            const name = p?.name ?? row.productRef;
            if (!(row.amountMinor > 0)) throw unprocessable('Amounts must be positive.', { lines: 'Invalid' });
            totalMinor += row.amountMinor;
            lines.push({ name, qty: { measure: 'mass', unit: 'g', base: 0 }, price: money(row.amountMinor) });
          }
          const otherMinor = Number((data.other as { amountMinor?: number })?.amountMinor ?? 0);
          totalMinor += Number(data.feeMinor ?? 0) + Number(data.transportMinor ?? 0) + otherMinor;
          if (otherMinor > 0) {
            data.other = { label: String((data.other as { label?: string })?.label || 'Other'), amount: money(otherMinor) };
          }
        } else {
          const offer = Number(data.offerMinor);
          if (!(offer > 0)) throw unprocessable('Offer must be positive.', { offerMinor: 'Required' });
          const deductMinor = Number((data.deduction as { amountMinor?: number })?.amountMinor ?? 0);
          totalMinor = offer - deductMinor;
          if (deductMinor > 0) {
            data.deduction = { label: String((data.deduction as { label?: string })?.label || 'Deduction'), amount: money(deductMinor) };
          }
          const sellQty = order.sell?.qty
            ?? order.lines?.[0]?.qty
            ?? { measure: 'mass' as const, unit: 'g' as const, base: Number(order.totalGrams || order.lines?.[0]?.grams || 0) };
          lines.push({
            name: order.sell?.name ?? order.lines?.[0]?.name ?? 'Sell offer',
            qty: sellQty,
            price: money(offer),
          });
        }

        await QuotationModel.updateMany({ orderId: order._id, status: 'issued' }, { $set: { status: 'replaced' } });
        const rev = (await QuotationModel.countDocuments({ orderId: order._id })) + 1;
        const number = `Q-${order.reference.replace(/\D/g, '').slice(-5)}${rev > 1 ? `-R${rev}` : ''}`;
        const validDays = Number(data.validDays ?? (data.validHours != null ? Number(data.validHours) / 24 : 3)) || 3;
        await QuotationModel.create({
          orderId: order._id,
          number,
          rev,
          lines,
          product: money(totalMinor),
          fee: money(Number(data.feeMinor ?? 0)),
          transport: money(Number(data.transportMinor ?? 0)),
          other: data.other as { label: string; amount: ReturnType<typeof money> } | undefined,
          deduction: data.deduction as { label: string; amount: ReturnType<typeof money> } | undefined,
          total: money(totalMinor),
          rateNote: data.marketRateNote as string | undefined,
          conditions: order.side === 'sell' ? 'Subject to Mineral Bridge inspection and SGS test report' : undefined,
          validUntil: new Date(Date.now() + validDays * 86_400_000),
          status: 'issued',
          issuedBy: actor,
          issuedAt: new Date(),
        });

        const updated = await casAdvanceOrder({
          order,
          toKey: 'quoteOk',
          actor,
          note: input.note ?? 'Quotation issued',
          version: input.version,
          extraSet: { 'pricing.quotedTotal': money(totalMinor) },
          clearHold: reissueAfterDecline,
        });
        void notifyUser(order.userId, {
          event: 'quotation.issued',
          title: `Quotation ready · ${order.reference}`,
          body: 'Review and accept or decline the quotation.',
          target: { type: 'order', id: order._id },
        });
        return updated;
      }
      case 'confirmed': {
        const q = await QuotationModel.findOne({ orderId: order._id, status: 'accepted' }).lean();
        return casAdvanceOrder({
          order,
          toKey: 'contract',
          actor,
          note: input.note,
          version: input.version,
          extraSet: {
            'pricing.lockedTotal': q?.total ?? order.pricing?.quotedTotal ?? order.total,
            'pricing.lockedAt': new Date(),
            priceConfirmed: true,
          },
        });
      }
      case 'contractMb': {
        return v2ContractService.countersign(order, { id: input.staff.id, name: input.staff.name, title: String(input.data.signatory ?? input.staff.name) }, input.version);
      }
      case 'payOk': {
        return v2PaymentsService.confirm(order, input.staff, input.version, input.data.confirmedRef as string | undefined);
      }
      case 'assigned': {
        let partnerId = String(input.data.partnerId ?? input.data.partner ?? '').trim();
        if (partnerId) {
          const { Partner } = await import('../../../models/content.models.js');
          const found = await Partner.findOne({ $or: [{ partnerId }, { name: partnerId }] }).lean();
          if (found?.partnerId) partnerId = String(found.partnerId);
        }
        if (!partnerId) throw unprocessable('Partner is required.', { partnerId: 'Required' });
        const shipment = await ShipmentModel.create({
          reference: await references.shipment(),
          ownerIds: [order.userId],
          orderId: order._id,
          direction: order.side === 'buy' ? 'vault_to_buyer' : 'seller_to_vault',
          partnerId,
          mode: input.data.mode ? [String(input.data.mode)] : ['road'],
          contact: input.data.contact ? String(input.data.contact) : undefined,
          pickup: input.data.pickupAt ? { scheduledAt: new Date(String(input.data.pickupAt)) } : undefined,
          status: 'booked',
          progressPercent: 0,
          events: [{ _id: opaqueId('sev'), index: 0, title: 'Partner assigned', projected: false, occurredAt: new Date() }],
          documents: [],
        });
        return casAdvanceOrder({
          order,
          toKey: 'picked',
          actor,
          note: input.note,
          version: input.version,
          extraSet: { 'links.shipmentId': shipment._id },
        });
      }
      case 'picked':
        await ShipmentModel.updateOne({ orderId: order._id }, { $set: { status: 'picked_up', currentLocation: String(input.data.location ?? '') } });
        return casAdvanceOrder({ order, toKey: 'transit', actor, note: input.note, version: input.version });
      case 'transit':
        await ShipmentModel.updateOne({ orderId: order._id }, { $set: { status: 'in_transit', currentLocation: String(input.data.location ?? '') } });
        return casAdvanceOrder({ order, toKey: 'delivered', actor, note: input.note, version: input.version });
      case 'delivered':
        await ShipmentModel.updateOne({ orderId: order._id }, { $set: { status: 'delivered', currentLocation: String(input.data.location ?? '') } });
        return casAdvanceOrder({ order, toKey: order.side === 'buy' ? 'receipt' : 'done', actor, note: input.note, version: input.version, extraSet: order.side === 'sell' ? { status: 'completed' } : undefined });
      case 'reviewed':
        return casAdvanceOrder({ order, toKey: 'quote', actor, note: input.note, version: input.version });
      case 'formOk': {
        // BUG-014: if the seller already gave a preferred slot, schedule inspection immediately.
        const slot = (order as { sellerForm?: { inspectionSlot?: { date?: string; time?: string; address?: string } } })
          .sellerForm?.inspectionSlot;
        if (slot?.date && slot?.time) {
          const after = await casAdvanceOrder({ order, toKey: 'schedule', actor, note: input.note, version: input.version });
          await InspectionModel.create({
            orderId: order._id,
            type: 'third_party',
            schedule: {
              date: String(slot.date),
              time: String(slot.time),
              location: String(slot.address ?? 'TBD'),
              scheduledBy: actor,
              at: new Date(),
            },
            status: 'scheduled',
          });
          return casAdvanceOrder({
            order: after,
            toKey: 'inspect',
            actor,
            note: input.note ?? 'Inspection scheduled from seller preference',
            version: after.version,
          });
        }
        return casAdvanceOrder({ order, toKey: 'schedule', actor, note: input.note, version: input.version });
      }
      case 'schedule': {
        await InspectionModel.create({
          orderId: order._id,
          type: (input.data.type as 'third_party' | 'platform_onsite') ?? 'platform_onsite',
          agencyPartnerId: input.data.agencyPartnerId as string | undefined,
          inspectorPartnerId: input.data.inspectorPartnerId as string | undefined,
          schedule: {
            date: String(input.data.date),
            time: String(input.data.time),
            location: String(input.data.location ?? 'TBD'),
            scheduledBy: actor,
            at: new Date(),
          },
          status: 'scheduled',
        });
        return casAdvanceOrder({ order, toKey: 'inspect', actor, note: input.note, version: input.version });
      }
      case 'inspect': {
        await InspectionModel.updateOne(
          { orderId: order._id },
          {
            $set: {
              status: 'completed',
              findings: {
                weight: input.data.weight,
                sampleNo: input.data.sampleNo,
                seals: input.data.seals,
                photoFileIds: input.data.photoFileIds,
                result: input.data.result,
                notes: input.data.notes,
                by: actor,
                at: new Date(),
              },
            },
          },
        );
        return casAdvanceOrder({ order, toKey: 'sgs', actor, note: input.note, version: input.version });
      }
      case 'sgs': {
        await InspectionModel.updateOne(
          { orderId: order._id },
          {
            $set: {
              status: 'report_uploaded',
              report: {
                certificateNo: String(input.data.certificateNo),
                grade: input.data.grade as string | undefined,
                net: input.data.net,
                result: input.data.result,
                fileId: input.data.fileId as string | undefined,
                uploadedBy: actor,
                at: new Date(),
              },
            },
          },
        );
        return casAdvanceOrder({ order, toKey: 'reportOk', actor, note: input.note, version: input.version });
      }
      case 'approved':
        return casAdvanceOrder({ order, toKey: 'payout', actor, note: input.note, version: input.version });
      case 'payout':
        return casAdvanceOrder({ order, toKey: 'ship', actor, note: input.note, version: input.version });
      case 'ship':
        return casAdvanceOrder({ order, toKey: 'delivered', actor, note: input.note, version: input.version });
      case 'done':
        return casAdvanceOrder({
          order,
          toKey: 'done',
          actor,
          note: input.note,
          version: input.version,
          extraSet: { status: 'completed' },
        });
      default:
        throw conflict('step/unknown', `No handler for step ${input.stepKey}`);
    }
  },

  async reject(ref: string, version: number, reason: string, staff: StaffActor) {
    const order = await loadOrderByRef(ref);
    assertOrderVersion(order, version);
    await OrderModel.findOneAndUpdate(
      { _id: order._id, version },
      {
        $set: {
          status: 'rejected',
          rejection: { reason, stageIndex: order.stageIndex, at: new Date(), stepKey: order.workflow?.stepKey, by: { kind: 'staff', id: staff.id, name: staff.name } },
        },
        $inc: { version: 1 },
      },
    );
    void notifyUser(order.userId, {
      event: 'order.rejected',
      title: `Order rejected · ${order.reference}`,
      body: reason,
      target: { type: 'order', id: order._id },
    });
    void enqueueOutbox('audit.orders', { action: 'Order rejected', actorId: staff.id, orderId: order._id });
    return this.detail(ref);
  },

  /**
   * Delete from the console. The order is never destroyed: it is cancelled and stamped `deletedAt`
   * (history, payments, payouts and documents stay for audit). A released payout always blocks it.
   * A payment already taken blocks it unless `force` is set and the caller holds the finance action.
   */
  async remove(
    ref: string,
    input: { reason: string; force?: boolean; canForce?: boolean; staff: StaffActor },
  ) {
    const order = await loadOrderByRef(ref);
    if (order.deletedAt) throw conflict('order/already-deleted', 'This order has already been deleted.');

    const payout = await SellerPayoutModel.findOne({ orderId: order._id }).lean();
    if (payout?.status === 'released') {
      throw conflict('order/payout-released', 'The payout for this order has been released, so it cannot be deleted.');
    }
    const confirmedPayment = await PaymentModel.findOne({ orderId: order._id, status: 'confirmed' }).lean();
    const paymentTaken = Boolean(confirmedPayment) || ['held', 'released'].includes(order.settlement?.status ?? '');
    if (paymentTaken) {
      if (!input.force) {
        throw conflict(
          'order/payment-recorded',
          'A payment is recorded against this order. Refund it first, or delete with force as finance.',
        );
      }
      if (!input.canForce) {
        throw forbidden('order/force-forbidden', 'Forcing the deletion of a paid order needs the finance permission.');
      }
    }

    const now = new Date();
    const actor = { kind: 'staff' as const, id: input.staff.id, name: input.staff.name, role: input.staff.role };
    const wasOpen = !['completed', 'rejected', 'cancelled'].includes(order.status);
    const reserved = order.side === 'buy' && wasOpen && consoleStage('buy', order.workflow?.stepKey, order.status).stage > 1;

    const updated = await OrderModel.findOneAndUpdate(
      { _id: order._id, version: order.version, deletedAt: { $exists: false } },
      {
        $set: {
          status: 'cancelled',
          deletedAt: now,
          deletedBy: actor,
          deleteReason: input.reason,
          cancellation: { reason: input.reason, at: now, refundMinor: 0, note: 'Deleted from the console', by: actor },
        },
        $unset: { hold: '' },
        $push: {
          timeline: {
            stepKey: order.workflow?.stepKey ?? 'deleted',
            label: 'Order deleted',
            actor,
            note: input.reason,
            at: now,
            data: { forced: Boolean(input.force && paymentTaken) },
          },
        },
        $inc: { version: 1 },
      },
      { new: true },
    ).lean<IOrder>();
    if (!updated) throw conflict('order/changed', 'This order changed. Reload and try again.');

    // Release everything this order was holding open.
    if (reserved) {
      for (const line of order.lines) {
        if (line.productId && line.grams > 0) await ordersRepository.restoreStock(line.productId, line.grams);
      }
    }
    const orderKeys = [String(order._id), order.reference];
    await Promise.all([
      QuotationModel.updateMany({ orderId: order._id, status: 'issued' }, { $set: { status: 'expired' } }),
      PaymentModel.updateMany({ orderId: order._id, status: { $in: ['initiated', 'submitted', 'confirming'] } }, { $set: { status: 'cancelled' } }),
      SellerPayoutModel.updateMany({ orderId: order._id, status: { $in: ['pending_approval', 'approved'] } }, { $set: { status: 'cancelled' } }),
      IssuedDocumentModel.updateMany(
        { 'entity.type': 'order', 'entity.id': { $in: orderKeys }, status: { $in: ['processing', 'issued'] } },
        { $set: { status: 'cancelled', cancelReason: 'Order deleted' } },
      ),
    ]);

    await recordAudit({
      actor: { staffId: input.staff.publicId || input.staff.id, name: input.staff.name },
      category: 'orders',
      action: 'Order deleted',
      record: { type: 'Order', id: order.reference, label: order.reference },
      reason: input.reason,
      before: { status: order.status },
      after: { status: 'cancelled', deleted: true, forced: Boolean(input.force && paymentTaken), stockRestored: reserved },
    });
    void notifyUser(order.userId, {
      event: 'order.cancelled',
      title: `Order cancelled · ${order.reference}`,
      body: input.reason,
      target: { type: 'order', id: order._id },
    });
    return { ref: order.reference, deleted: true as const, status: 'cancelled' as const, stockRestored: reserved };
  },
};
