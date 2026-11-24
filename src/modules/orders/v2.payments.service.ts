import { AppError, conflict, unprocessable } from '../../common/errors/app-error.js';
import { opaqueId } from '../../common/utils/ids.js';
import { OrderModel, type IOrder } from '../../models/order.model.js';
import { PaymentModel, type IPayment } from '../../models/workflow.model.js';
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
import { v2OrdersService } from './v2.orders.service.js';

const BANK_METHODS = new Set(['bank_transfer', 'neft', 'rtgs']);

function normalizeMethod(method: string): IPayment['method'] {
  if (method === 'neft' || method === 'rtgs') return 'bank_transfer';
  if (
    method === 'bank_transfer' ||
    method === 'upi' ||
    method === 'net_banking' ||
    method === 'btc' ||
    method === 'lc' ||
    method === 'other' ||
    method === 'wire' ||
    method === 'escrow'
  ) {
    return method;
  }
  throw unprocessable('Payment method is not enabled.', { method }, 'payment/method-disabled');
}

function paymentDto(p: IPayment) {
  return {
    id: p._id,
    method: p.method,
    status: p.status,
    amount: p.amount,
    attempt: p.attempt,
    proofFileIds: p.proofFileIds,
    btc: p.btc
      ? {
          address: p.btc.address,
          amountSats: p.btc.amountSats,
          rateMinorPerBtc: p.btc.rateMinorPerBtc,
          lockExpiresAt: p.btc.lockExpiresAt?.toISOString?.() ?? p.btc.lockExpiresAt,
          txid: p.btc.txid,
          confirmations: p.btc.confirmations,
        }
      : undefined,
    confirmedAt: p.confirmedAt?.toISOString?.() ?? null,
    createdAt: p.createdAt.toISOString(),
  };
}

export const v2PaymentsService = {
  async submitBuyerForm(
    userId: string,
    ref: string,
    body: {
      method: string;
      terms: string;
      billing: { name: string; address: string };
      instructions?: string;
      confirmed: true;
      version: number;
    },
  ) {
    const order = await loadOwnedOrder(userId, ref);
    assertOrderVersion(order, body.version);
    assertCurrent(workflowStateFromOrder(order), 'paid');
    const updated = await OrderModel.findOneAndUpdate(
      { _id: order._id, version: body.version },
      {
        $set: {
          buyerForm: {
            method: body.method,
            terms: body.terms,
            billing: body.billing,
            instructions: body.instructions,
            confirmedAt: new Date(),
          },
        },
        $push: {
          timeline: {
            stepKey: 'paid',
            label: 'Payment details submitted',
            actor: { kind: 'customer', id: userId },
            at: new Date(),
          },
        },
        $inc: { version: 1 },
      },
      { new: true },
    );
    if (!updated) throw conflict('step/version', 'Order was updated elsewhere. Refresh and retry.');
    void enqueueOutbox('audit.orders', { action: 'Payment details submitted', actorId: userId, orderId: order._id });
    return v2OrdersService.get(userId, order.reference);
  },

  async btcQuote(userId: string, ref: string) {
    const order = await loadOwnedOrder(userId, ref);
    assertCurrent(workflowStateFromOrder(order), 'paid');
    // Manual BTC: rate from env/settings stub; address from configured wallet.
    // USD minor units (scale 2): $68,510.00 → 6_851_000. Override with BTC_USD_RATE_MINOR.
    const rateMinorPerBtc = Number(process.env.BTC_USD_RATE_MINOR ?? '6851000');
    const amountMinor = order.pricing?.lockedTotal?.amountMinor ?? order.total.amountMinor;
    const amountSats = Math.max(1, Math.round((amountMinor / rateMinorPerBtc) * 100_000_000));
    const address = process.env.BTC_RECEIVING_ADDRESS ?? 'bc1qmineralbridgeplaceholder000000000000';
    const lockExpiresAt = new Date(Date.now() + 15 * 60_000);

    await PaymentModel.updateMany(
      { orderId: order._id, method: 'btc', status: 'initiated' },
      { $set: { status: 'cancelled' } },
    );

    const payment = await PaymentModel.create({
      orderId: order._id,
      userId,
      method: 'btc',
      amount: order.pricing?.lockedTotal ?? order.total,
      status: 'initiated',
      attempt: 1,
      proofFileIds: [],
      btc: { rateMinorPerBtc, amountSats, address, lockExpiresAt, confirmations: 0, requiredConfirmations: 1 },
    });

    return {
      paymentId: payment._id,
      address,
      amountSats,
      rateMinorPerBtc,
      amount: payment.amount,
      lockExpiresAt: lockExpiresAt.toISOString(),
    };
  },

  async submit(
    userId: string,
    ref: string,
    body: {
      method: string;
      proofFileIds?: string[];
      btcTxid?: string;
      reference?: string;
      terms?: string;
      billing?: { name: string; address: string };
      version: number;
    },
  ) {
    const order = await loadOwnedOrder(userId, ref);
    assertOrderVersion(order, body.version);
    assertCurrent(workflowStateFromOrder(order), 'paid');

    const existing = await PaymentModel.findOne({
      orderId: order._id,
      status: { $in: ['submitted', 'confirming'] },
    }).lean();
    if (existing) throw conflict('payment/already-submitted', 'A payment is already awaiting confirmation.');

    const method = normalizeMethod(body.method);
    if (BANK_METHODS.has(body.method) && !(body.proofFileIds?.length)) {
      throw unprocessable('Upload payment proof.', { proofFileIds: 'Required' }, 'payment/proof-required');
    }
    if (body.proofFileIds?.length) await uploadsService.ownedMany(userId, body.proofFileIds);
    if (method === 'btc') {
      const quote = await PaymentModel.findOne({ orderId: order._id, method: 'btc', status: 'initiated' }).lean();
      if (!quote?.btc?.lockExpiresAt || quote.btc.lockExpiresAt.getTime() <= Date.now()) {
        throw new AppError({ status: 410, code: 'payment/btc-quote-expired', message: 'BTC quote expired. Request a new quote.' });
      }
      if (!body.btcTxid || !/^[0-9a-fA-Fx]{16,}$/.test(body.btcTxid)) {
        throw unprocessable('Enter a valid BTC transaction id.', { btcTxid: 'Invalid' });
      }
    }
    const reference = (body.reference || '').trim();
    const referenceRequired = method === 'upi' || method === 'net_banking';
    if (referenceRequired && !reference) {
      throw unprocessable('Payment reference is required.', { reference: 'Required' });
    }
    if (reference && reference.length < 6) {
      throw unprocessable('Enter the payment reference (at least 6 characters).', { reference: 'Too short' });
    }

    if (body.terms || body.billing) {
      await OrderModel.updateOne(
        { _id: order._id },
        {
          $set: {
            buyerForm: {
              method: body.method,
              terms: body.terms,
              billing: body.billing,
              confirmedAt: new Date(),
            },
          },
        },
      );
    }

    const quote = method === 'btc'
      ? await PaymentModel.findOne({ orderId: order._id, method: 'btc', status: 'initiated' })
      : null;
    const attempt = (await PaymentModel.countDocuments({ orderId: order._id })) + (quote ? 0 : 1);
    const payment = quote ?? new PaymentModel({
      orderId: order._id,
      userId,
      method,
      amount: order.pricing?.lockedTotal ?? order.total,
      attempt,
      proofFileIds: [],
    });
    payment.status = 'submitted';
    payment.proofFileIds = body.proofFileIds ?? payment.proofFileIds ?? [];
    if (reference) payment.gateway = { provider: method, reference };
    if (method === 'btc' && payment.btc) {
      payment.btc = { ...payment.btc, txid: body.btcTxid, confirmations: 0 };
      payment.markModified('btc');
    }
    await payment.save();

    await casAdvanceOrder({
      order,
      toKey: 'payOk',
      actor: { kind: 'customer', id: userId },
      note: 'Payment submitted for confirmation',
      version: body.version,
      extraSet: {
        'links.paymentId': payment._id,
        paymentTaken: false,
        settlement: { method: order.settlement?.method ?? 'escrow', status: 'not_funded' },
      },
    });

    void notifyUser(userId, {
      event: 'payment.submitted',
      title: 'Payment submitted for confirmation',
      body: `Payment for ${order.reference} is being reviewed.`,
      target: { type: 'order', id: order._id },
    });
    void enqueueOutbox('payment.submitted', { orderId: order._id, paymentId: payment._id });
    void enqueueOutbox('audit.payments', { action: 'Payment submitted', actorId: userId, orderId: order._id });

    return {
      payment: paymentDto(payment.toObject() as IPayment),
      order: await v2OrdersService.get(userId, order.reference),
    };
  },

  /** Admin finance confirmation (APAY-03 / payOk step). */
  async confirm(order: IOrder, staff: { id: string; name: string }, version: number, confirmedRef?: string) {
    assertOrderVersion(order, version);
    assertCurrent(workflowStateFromOrder(order), 'payOk');
    const payment = await PaymentModel.findOne({
      orderId: order._id,
      status: { $in: ['submitted', 'confirming'] },
    });
    if (!payment) throw conflict('payment/missing', 'No payment awaiting confirmation.');
    payment.status = 'confirmed';
    payment.confirmedAt = new Date();
    payment.confirmedBy = { kind: 'staff', id: staff.id, name: staff.name };
    payment.confirmedRef = confirmedRef ?? opaqueId('prf');
    await payment.save();

    const next = 'assigned';
    const updated = await casAdvanceOrder({
      order,
      toKey: next,
      actor: { kind: 'staff', id: staff.id, name: staff.name },
      note: 'Payment confirmed',
      version,
      extraSet: {
        paymentTaken: true,
        settlement: {
          method: order.settlement?.method ?? 'escrow',
          status: 'held',
          fundedAt: new Date(),
          escrowReference: payment.confirmedRef,
        },
      },
    });

    void notifyUser(order.userId, {
      event: 'payment.confirmed',
      title: `Payment confirmed · ${order.reference}`,
      body: 'Your payment has been verified.',
      target: { type: 'order', id: order._id },
    });
    void enqueueOutbox('payment.confirmed', { orderId: order._id, paymentId: payment._id });
    return updated;
  },

  /** Staff-recorded off-app payment (APAY-06) while the order waits on the customer `paid` step. */
  async recordManual(
    order: IOrder,
    staff: { id: string; name: string },
    body: {
      method: string;
      reference: string;
      amountMinor?: number;
      proofFileIds?: string[];
      version: number;
      idempotencyKey?: string;
    },
  ) {
    assertOrderVersion(order, body.version);
    assertCurrent(workflowStateFromOrder(order), 'paid');
    const existing = await PaymentModel.findOne({
      orderId: order._id,
      status: { $in: ['submitted', 'confirming'] },
    }).lean();
    if (existing) throw conflict('payment/already-submitted', 'A payment is already awaiting confirmation.');

    const method = normalizeMethod(body.method);
    const amountMinor =
      body.amountMinor && body.amountMinor > 0
        ? body.amountMinor
        : order.pricing?.lockedTotal?.amountMinor ?? order.total.amountMinor;
    const amount = {
      amountMinor,
      currency: order.total.currency,
      scale: order.total.scale ?? 2,
    };
    const attempt = (await PaymentModel.countDocuments({ orderId: order._id })) + 1;
  const payment = await PaymentModel.create({
      orderId: order._id,
      userId: order.userId,
      method,
      amount,
      status: 'submitted',
      attempt,
      proofFileIds: body.proofFileIds ?? [],
      gateway: body.reference ? { provider: method, reference: body.reference } : undefined,
      idempotencyKey: body.idempotencyKey,
    });

    await casAdvanceOrder({
      order,
      toKey: 'payOk',
      actor: { kind: 'staff', id: staff.id, name: staff.name },
      note: `Payment recorded · ${body.reference}`,
      version: body.version,
      extraSet: {
        'links.paymentId': payment._id,
        paymentTaken: false,
        settlement: { method: order.settlement?.method ?? 'escrow', status: 'not_funded' },
      },
    });

    void enqueueOutbox('audit.payments', {
      action: 'Payment recorded manually',
      actorId: staff.id,
      orderId: order._id,
      paymentId: payment._id,
    });

    return { payment: paymentDto(payment.toObject() as IPayment) };
  },

  async reject(order: IOrder, staff: { id: string; name: string }, version: number, reason: string) {
    assertOrderVersion(order, version);
    assertCurrent(workflowStateFromOrder(order), 'payOk');
    await PaymentModel.updateOne(
      { orderId: order._id, status: { $in: ['submitted', 'confirming'] } },
      {
        $set: {
          status: 'failed',
          failure: { code: 'payment/rejected', reason, at: new Date() },
        },
      },
    );
    // Return customer to paid to resubmit.
    return casAdvanceOrder({
      order,
      toKey: 'paid',
      actor: { kind: 'staff', id: staff.id, name: staff.name },
      note: `Payment rejected: ${reason}`,
      version,
      // A leftover quotation hold must not block the retry (BUG-010).
      clearHold: true,
    });
  },
};
