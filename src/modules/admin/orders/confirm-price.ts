import { AppError, notFound } from '../../../common/errors/app-error.js';
import { withTx } from '../../../common/db/transaction.js';
import { writeConfirmedCustomerPrice } from '../../../integration/customer-admin.bridge.js';
import { notifyUser } from '../../notifications/notifications.service.js';
import { recordAudit, type AuditActor } from '../../audit/audit.service.js';
import { User } from '../../../models/people.models.js';
import { Order } from '../../../models/trading.models.js';
import { formatMoneyText, outMoney, outUnitPrice, parseUnitPrice, priceTimesQuantity, type AdminUnitPrice } from '../shared/money.js';

const PAID_STAGES = new Set(['payment_released', 'custody_transfer']);

/** Desk types the unit rate agreed with the customer. Order value is derived and only then becomes visible. */
export async function confirmAgreedPrice(input: {
  orderId: string;
  unitPrice: AdminUnitPrice;
  note?: string;
  actor: AuditActor;
  req?: { requestId?: string; ip?: string };
}) {
  const o = await Order.findOne({ orderId: input.orderId }).lean();
  if (!o) throw notFound('resource/not-found', `Order ${input.orderId} not found`);
  if (o.status === 'draft' || o.status === 'cancelled') {
    throw new AppError({ status: 422, code: 'rule/price-not-editable', message: `${input.orderId} cannot take a price in its current state.` });
  }
  if (o.paymentStatus === 'released' || PAID_STAGES.has(o.stage)) {
    throw new AppError({ status: 422, code: 'rule/price-already-settled', message: 'Payment has already been released, so this price can no longer be changed.' });
  }
  if (!o.quantity?.value || !o.quantity?.unit) {
    throw new AppError({ status: 422, code: 'rule/quantity-missing', message: 'This order has no quantity to price.' });
  }
  const lockedRate = parseUnitPrice(input.unitPrice, 'unitPrice');
  if (lockedRate.amountMinor <= 0) {
    throw new AppError({ status: 422, code: 'validation/failed', message: 'Enter a price greater than 0.', fields: { unitPrice: 'Must be greater than 0' } });
  }
  const value = priceTimesQuantity(lockedRate, o.quantity);
  const rateLabel = `${formatMoneyText(outUnitPrice(lockedRate))} / ${lockedRate.per}`;
  const valueLabel = formatMoneyText(outMoney(value));
  const now = new Date();
  const actor = input.actor;
  const { updated, auditId } = await withTx(async (session) => {
    const updated = await Order.findOneAndUpdate(
      { orderId: input.orderId, status: { $in: ['active', 'completed'] }, paymentStatus: { $ne: 'released' } },
      {
        $set: { lockedRate, value, priceConfirmedAt: now, priceConfirmedBy: actor.staffId },
        $push: { history: { text: `Agreed price confirmed at ${rateLabel} · order value ${valueLabel}${input.note ? ` — ${input.note}` : ''}`, actorId: actor.staffId, at: now } },
      },
      { new: true, session },
    ).lean();
    if (!updated) {
      throw new AppError({ status: 422, code: 'rule/price-already-settled', message: 'Payment has already been released, so this price can no longer be changed.' });
    }
    await writeConfirmedCustomerPrice(input.orderId, value, { amount: input.unitPrice.amount, per: lockedRate.per }, session);
    const auditId = await recordAudit({
      actor,
      category: 'orders',
      action: 'Confirmed agreed price',
      record: { type: 'order', id: input.orderId, label: input.orderId },
      before: { priceConfirmed: Boolean(o.priceConfirmedAt) },
      after: { unitPrice: outUnitPrice(lockedRate), value: outMoney(value) },
      reason: input.note,
      req: input.req as never,
      session,
      activity: { text: `Agreed price confirmed on ${input.orderId}`, meta: `${rateLabel} · ${valueLabel}`, kind: 'order' },
    });
    return { updated, auditId };
  });
  const customer = await User.findOne({ userId: o.counterpartyId }).select('userId').lean();
  if (customer) {
    void notifyUser(o.counterpartyId, {
      event: 'order.quote_ready',
      title: `Price confirmed for ${input.orderId}`,
      body: `The agreed rate is ${rateLabel}. Order value ${valueLabel}.`,
      target: { type: 'order', id: input.orderId },
      data: { orderId: input.orderId },
    });
  }
  return { order: updated, message: `Agreed price confirmed at ${rateLabel} · order value ${valueLabel}`, auditId };
}
