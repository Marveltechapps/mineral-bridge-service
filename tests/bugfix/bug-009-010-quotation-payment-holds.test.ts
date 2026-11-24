/**
 * BUG-009: Declined quotation hold must clear when admin reissues quote so customer can accept.
 * BUG-010: Payment reject returns order to paid without hold; customer can submit payment again.
 * @tags bugfix orders payments
 */
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMemoryReplSet, stopMemoryReplSet } from '../setup.js';

const PASSWORD = 'Correct-Horse-9!Battery';
const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD', scale: 2 });

describe('bugfix orders BUG-009 quotation reissue after decline', () => {
  let app: Express;

  beforeAll(async () => {
    await startMemoryReplSet('mb_bug_009');
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    const { resetEnvCache } = await import('../../src/config/env.js');
    resetEnvCache();
    const { connectDatabase } = await import('../../src/config/database.js');
    await connectDatabase();
    const { createApp } = await import('../../src/app.js');
    app = createApp();
    const { createStaff } = await import('../../src/modules/staff/staff.service.js');
    await createStaff({ email: 'bug009.ceo@mineralbridge.test', password: PASSWORD, name: 'Bug CEO', roleId: 'ROLE-CEO' });
  }, 120_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await stopMemoryReplSet();
  });

  it('bug_009_decline_reissue_accept: decline → reissue quote → accept succeeds', async () => {
    const agent = request.agent(app);
    const sign = await agent.post('/v2/admin/auth/sign-in').set('X-Client', 'admin').send({
      email: 'bug009.ceo@mineralbridge.test', password: PASSWORD,
    });
    expect(sign.status).toBe(200);
    const csrf = String(sign.headers['x-csrf-token'] || '');
    const call = (method: 'get' | 'post', url: string) =>
      agent[method](url).set('X-Client', 'admin').set('X-CSRF-Token', csrf);

    const { UserModel } = await import('../../src/modules/users/user.model.js');
    const { ProductModel } = await import('../../src/models/catalog.model.js');
    const { OrderModel } = await import('../../src/models/order.model.js');
    const { v2OrdersService } = await import('../../src/modules/orders/v2.orders.service.js');

    const buyer = await UserModel.create({
      customerNo: 'C-BUG009',
      email: 'bug009.buyer@example.com',
      phone: '+254711000909',
      roles: ['buyer'],
      kycStatus: 'verified',
      accountStatus: 'active',
      profile: { fullName: 'Bug Buyer', countryCode: 'KE' },
    });
    const userId = String(buyer._id);
    await ProductModel.create({
      reference: 'LOT-BUG-009',
      name: 'Bug Gold',
      typeSlug: 'gold',
      categorySlug: 'precious',
      mineralCode: 'AU',
      origin: { country: 'KE' },
      status: 'active',
      availableGrams: 5000,
      minOrderGrams: 100,
      unitPriceMinorE4PerGram: 1,
      seller: { name: 'Mineral Bridge', tier: 'mineral_bridge', verified: true },
      attributes: {},
    });
  const order = await OrderModel.create({
      reference: 'MB-BUG-009',
      userId,
      customerNo: 'C-BUG009',
      side: 'buy',
      status: 'active',
      source: { kind: 'admin' },
      workflow: { definition: 'buy.v2', stepKey: 'quote', stepIndex: 1, owner: 'platform', role: 'trading', enteredAt: new Date() },
      lines: [{ name: 'Bug Gold', productId: 'x', grams: 1000, unitPriceMinorE4PerGram: 1, lineTotalMinor: 5000 }],
      totalGrams: 1000,
      subtotal: usd(5000),
      platformFee: usd(0),
      surcharge: usd(0),
      total: usd(5000),
      version: 1,
    });

    const quoted = await call('post', '/v2/admin/orders/MB-BUG-009/steps/quote').send({
      version: 1,
      data: { lines: [{ productRef: 'LOT-BUG-009', amountMinor: 5000 }], feeMinor: 0, validDays: 7 },
    });
    expect(quoted.status, JSON.stringify(quoted.body)).toBe(200);

    let detail = await v2OrdersService.get(userId, 'MB-BUG-009') as {
      version: number;
      quotation?: { number: string };
      hold?: { type?: string } | null;
    };
    const firstNumber = detail.quotation!.number;

    await v2OrdersService.declineQuotation({
      userId,
      ref: 'MB-BUG-009',
      quotationNumber: firstNumber,
      version: detail.version,
      reason: 'Price too high for this month',
    });
    const afterDecline = await OrderModel.findOne({ reference: 'MB-BUG-009' }).lean();
    expect(afterDecline?.hold?.type).toBe('declined');
    expect(afterDecline?.workflow?.stepKey).toBe('quoteOk');

    const reissue = await call('post', '/v2/admin/orders/MB-BUG-009/steps/quote').send({
      version: afterDecline!.version,
      data: { lines: [{ productRef: 'LOT-BUG-009', amountMinor: 4500 }], feeMinor: 0, validDays: 7 },
    });
    expect(reissue.status, JSON.stringify(reissue.body)).toBe(200);

    const afterReissue = await OrderModel.findOne({ reference: 'MB-BUG-009' }).lean();
    expect(afterReissue?.hold?.type).toBeFalsy();

    detail = await v2OrdersService.get(userId, 'MB-BUG-009') as {
      version: number;
      quotation?: { number: string };
    };
    expect(detail.quotation?.number).not.toBe(firstNumber);

    const accepted = await v2OrdersService.acceptQuotation({
      userId,
      ref: 'MB-BUG-009',
      quotationNumber: detail.quotation!.number,
      version: detail.version,
    }) as { workflow?: { current?: { key?: string } } };
    expect(accepted.workflow?.current?.key).toBe('confirmed');
  });

  it('bug_009_reissue_blocked_while_other_hold: unrelated hold types still block reissue', async () => {
    const agent = request.agent(app);
    const sign = await agent.post('/v2/admin/auth/sign-in').set('X-Client', 'admin').send({
      email: 'bug009.ceo@mineralbridge.test', password: PASSWORD,
    });
    const csrf = String(sign.headers['x-csrf-token'] || '');
    const { OrderModel } = await import('../../src/models/order.model.js');
    const { UserModel } = await import('../../src/modules/users/user.model.js');

    const buyer = await UserModel.findOne({ email: 'bug009.buyer@example.com' }).lean();
    const held = await OrderModel.create({
      reference: 'MB-BUG-009-HOLD',
      userId: buyer!._id,
      side: 'buy',
      status: 'active',
      source: { kind: 'admin' },
      workflow: { definition: 'buy.v2', stepKey: 'quoteOk', stepIndex: 2, owner: 'customer', role: 'customer', enteredAt: new Date() },
      lines: [],
      totalGrams: 0,
      subtotal: usd(100),
      platformFee: usd(0),
      surcharge: usd(0),
      total: usd(100),
      version: 1,
      hold: { type: 'changes', reason: 'Address fix', openedAt: new Date() },
    });

    const res = await agent
      .post('/v2/admin/orders/MB-BUG-009-HOLD/steps/quote')
      .set('X-Client', 'admin')
      .set('X-CSRF-Token', csrf)
      .send({ version: held.version, data: { lines: [{ productRef: 'LOT-BUG-009', amountMinor: 100 }], validDays: 3 } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('step/hold');
  });
});

describe('bugfix payments BUG-010 resubmit after admin reject', () => {
  let app: Express;

  beforeAll(async () => {
    await startMemoryReplSet('mb_bug_010');
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    const { resetEnvCache } = await import('../../src/config/env.js');
    resetEnvCache();
    const { connectDatabase } = await import('../../src/config/database.js');
    await connectDatabase();
    const { createApp } = await import('../../src/app.js');
    app = createApp();
    const { createStaff } = await import('../../src/modules/staff/staff.service.js');
    await createStaff({ email: 'bug010.ceo@mineralbridge.test', password: PASSWORD, name: 'Bug CEO', roleId: 'ROLE-CEO' });
  }, 120_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await stopMemoryReplSet();
  });

  it('bug_010_reject_then_resubmit: payment reject returns to paid with no hold; second submit works', async () => {
    const agent = request.agent(app);
    const sign = await agent.post('/v2/admin/auth/sign-in').set('X-Client', 'admin').send({
      email: 'bug010.ceo@mineralbridge.test', password: PASSWORD,
    });
    expect(sign.status).toBe(200);
    const csrf = String(sign.headers['x-csrf-token'] || '');

    const { UserModel } = await import('../../src/modules/users/user.model.js');
    const { OrderModel } = await import('../../src/models/order.model.js');
    const { PaymentModel } = await import('../../src/models/workflow.model.js');
    const { FileModel } = await import('../../src/models/file.model.js');
    const { v2PaymentsService } = await import('../../src/modules/orders/v2.payments.service.js');

    const buyer = await UserModel.create({
      customerNo: 'C-BUG010',
      email: 'bug010.buyer@example.com',
      phone: '+254711001010',
      roles: ['buyer'],
      kycStatus: 'verified',
      accountStatus: 'active',
      profile: { fullName: 'Bug Ten', countryCode: 'KE' },
    });
    const userId = String(buyer._id);
    const proof = await FileModel.create({
      ownerId: userId,
      purpose: 'payment_proof',
      filename: 'proof.jpg',
      contentType: 'image/jpeg',
      bytes: 100,
      storageKey: 'test/proof.jpg',
    });

    const order = await OrderModel.create({
      reference: 'MB-BUG-010',
      userId,
      side: 'buy',
      status: 'active',
      source: { kind: 'admin' },
      workflow: { definition: 'buy.v2', stepKey: 'paid', stepIndex: 7, owner: 'customer', role: 'customer', enteredAt: new Date() },
      lines: [{ name: 'Gold', grams: 10, unitPriceMinorE4PerGram: 1, lineTotalMinor: 1000 }],
      totalGrams: 10,
      subtotal: usd(1000),
      platformFee: usd(0),
      surcharge: usd(0),
      total: usd(1000),
      version: 3,
    });

    await v2PaymentsService.submit(userId, 'MB-BUG-010', {
      method: 'bank_transfer',
      proofFileIds: [String(proof._id)],
      version: 3,
    });
    let row = await OrderModel.findOne({ reference: 'MB-BUG-010' }).lean();
    expect(row?.workflow?.stepKey).toBe('payOk');
    expect(row?.hold?.type).toBeFalsy();

    const rejected = await agent
      .post('/v2/admin/payments/MB-BUG-010/reject')
      .set('X-Client', 'admin')
      .set('X-CSRF-Token', csrf)
      .send({ version: row!.version, reason: 'Amount mismatch' });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);

    row = await OrderModel.findOne({ reference: 'MB-BUG-010' }).lean();
    expect(row?.workflow?.stepKey).toBe('paid');
    expect(row?.hold?.type).toBeFalsy();

    await v2PaymentsService.submit(userId, 'MB-BUG-010', {
      method: 'bank_transfer',
      proofFileIds: [String(proof._id)],
      reference: 'NEFT-2ND-TRY',
      version: row!.version!,
    });
    row = await OrderModel.findOne({ reference: 'MB-BUG-010' }).lean();
    expect(row?.workflow?.stepKey).toBe('payOk');
    const attempts = await PaymentModel.countDocuments({ orderId: order._id, status: 'submitted' });
    expect(attempts).toBe(1);
  });

  it('bug_010_neighbour_quote_accept_without_hold: quotation accept is unrelated to payment reject hold', async () => {
    const { UserModel } = await import('../../src/modules/users/user.model.js');
    const { OrderModel } = await import('../../src/models/order.model.js');
    const { v2OrdersService } = await import('../../src/modules/orders/v2.orders.service.js');
    const { QuotationModel } = await import('../../src/models/workflow.model.js');

    const buyer = await UserModel.create({
      email: 'bug010q@example.com',
      phone: '+254711001011',
      roles: ['buyer'],
      kycStatus: 'verified',
      accountStatus: 'active',
      profile: { fullName: 'Q Only' },
    });
    const userId = String(buyer._id);
    const ord = await OrderModel.create({
      reference: 'MB-BUG-010-Q',
      userId,
      side: 'buy',
      status: 'active',
      source: { kind: 'admin' },
      workflow: { definition: 'buy.v2', stepKey: 'quoteOk', stepIndex: 2, owner: 'customer', role: 'customer', enteredAt: new Date() },
      lines: [],
      totalGrams: 0,
      subtotal: usd(200),
      platformFee: usd(0),
      surcharge: usd(0),
      total: usd(200),
      version: 1,
    });
    await QuotationModel.create({
      orderId: ord._id,
      number: 'Q-BUG10',
      rev: 1,
      lines: [],
      product: usd(200),
      fee: usd(0),
      transport: usd(0),
      total: usd(200),
      validUntil: new Date(Date.now() + 86_400_000),
      status: 'issued',
      issuedAt: new Date(),
      issuedBy: { kind: 'staff', id: 'staff-1', name: 'Desk' },
    });

    const accepted = await v2OrdersService.acceptQuotation({
      userId,
      ref: 'MB-BUG-010-Q',
      quotationNumber: 'Q-BUG10',
      version: 1,
    }) as { workflow?: { current?: { key?: string } } };
    expect(accepted.workflow?.current?.key).toBe('confirmed');
  });
});