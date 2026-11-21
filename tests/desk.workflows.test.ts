import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toMobileNotification } from '../src/modules/notifications/notifications.dto.js';
import { hostedDatabase, planLegacyCheckout } from '../src/modules/admin/v2/legacy-order-migration.js';
import { startMemoryReplSet, stopMemoryReplSet } from './setup.js';

const PASSWORD = 'Correct-Horse-9!Battery';
const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD', scale: 2 });
const PDF = Buffer.from('%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');

describe('migration plan and notification kinds', () => {
  it('skips duplicates and customers that are not in users, and blocks hosted writes', () => {
    const ctx = { existingRefs: new Set(['MB-1']), userIds: new Set(['user-1']), batch: 't' };
    expect(planLegacyCheckout({ orderId: 'MB-1', userId: 'user-1' }, ctx).action).toBe('skip');
    expect(planLegacyCheckout({ orderId: 'MB-2', userId: 'missing' }, ctx).action).toBe('skip');
    const planned = planLegacyCheckout({
      orderId: 'MB-2', userId: 'user-1', mineralName: 'Gold', quantity: 2, unit: 'kg', totalDue: 10, type: 'buy', status: 'open',
    }, ctx);
    expect(planned.action).toBe('insert');
    if (planned.action === 'insert') {
      expect(planned.document.total).toMatchObject({ amountMinor: 1000 });
      expect((planned.document.lines as { grams: number }[])[0]?.grams).toBe(2000);
      expect(planned.document.migration).toMatchObject({ source: 'legacy-orders', reversible: true, totalDueOriginal: 10 });
    const tonnes = planLegacyCheckout({ orderId: 'MB-3', userId: 'user-1', quantity: 2, unit: 'MT', totalDue: 10, type: 'buy' }, ctx);
    expect(tonnes.action).toBe('insert');
    if (tonnes.action === 'insert') expect((tonnes.document.lines as { grams: number }[])[0]?.grams).toBe(2_000_000);
    expect(planLegacyCheckout({ orderId: 'MB-4', userId: 'user-1', type: 'buy' }, ctx)).toMatchObject({ action: 'skip', reason: 'missing totalDue' });
    }
    expect(hostedDatabase('mongodb+srv://example.mongodb.net/mineral_bridge')).toBe(true);
    expect(hostedDatabase('mongodb://127.0.0.1:27017/local')).toBe(false);
  });

  it('maps auction opening and a rejected KYC decision to distinct mobile kinds', () => {
    const base = { _id: 'n1', userId: 'u', kind: 'kyc' as const, title: 't', body: 'b', createdAt: new Date(), event: 'kyc.decided' };
    expect(toMobileNotification({ ...base, data: { decision: 'rejected' } }).kind).toBe('kyc_rejected');
    expect(toMobileNotification({ ...base, event: 'auction.opening', kind: 'auction' }).kind).toBe('auction_opening');
    expect(toMobileNotification({ ...base, event: 'auction.ending', kind: 'auction' }).kind).toBe('auction_ending');
  });
});

describe('desk workflows against the database', () => {
  let app: Express;

  beforeAll(async () => {
    await startMemoryReplSet('mb_desk_it');
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    const { resetEnvCache } = await import('../src/config/env.js');
    resetEnvCache();
    const { connectDatabase } = await import('../src/config/database.js');
    await connectDatabase();
    const { createApp } = await import('../src/app.js');
    app = createApp();
    const { createStaff } = await import('../src/modules/staff/staff.service.js');
    await createStaff({ email: 'desk.ceo@mineralbridge.test', password: PASSWORD, name: 'Desk CEO', roleId: 'ROLE-CEO' });
  }, 120_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await stopMemoryReplSet();
  });

  it('persists the eight desk workflows and a buy quotation chain', async () => {
    const agent = request.agent(app);
    const sign = await agent.post('/v2/admin/auth/sign-in').set('X-Client', 'admin').send({
      email: 'desk.ceo@mineralbridge.test', password: PASSWORD,
    });
    expect(sign.status, JSON.stringify(sign.body)).toBe(200);
    const csrf = String(sign.headers['x-csrf-token'] || '');
    const call = (method: 'get' | 'post' | 'patch' | 'delete', url: string) =>
      agent[method](url).set('X-Client', 'admin').set('X-CSRF-Token', csrf);

    const { UserModel } = await import('../src/modules/users/user.model.js');
    const { ProductModel } = await import('../src/models/catalog.model.js');
    const { OrderModel } = await import('../src/models/order.model.js');
    const { PaymentModel, RefundModel, IssuedDocumentModel } = await import('../src/models/workflow.model.js');
    const { SupportTicketModel } = await import('../src/models/support.model.js');
    const { NotificationModel } = await import('../src/models/notification.model.js');
    const { ShipmentModel } = await import('../src/models/contract-lc.model.js');
    const { KycSubmissionModel } = await import('../src/modules/kyc/kyc.model.js');

    const buyer = await UserModel.create({
      customerNo: 'C-9101',
      email: 'desk.buyer@example.com',
      phone: '+254711910001',
      roles: ['buyer'],
      kycStatus: 'pending',
      accountStatus: 'active',
      profile: { fullName: 'Desk Buyer', countryCode: 'KE' },
    });
    const lot = await ProductModel.create({
      reference: 'LOT-DESK-1',
      name: 'Desk Gold',
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
      reference: 'MB-ORD-DESK-1',
      userId: String(buyer._id),
      customerNo: 'C-9101',
      side: 'buy',
      status: 'active',
      source: { kind: 'admin' },
      workflow: { definition: 'buy.v2', stepKey: 'quote', stepIndex: 1, owner: 'platform', role: 'trading', enteredAt: new Date() },
      lines: [{ name: 'Desk Gold', productId: String(lot._id), grams: 1000, unitPriceMinorE4PerGram: 1, lineTotalMinor: 5000 }],
      totalGrams: 1000,
      subtotal: usd(5000),
      platformFee: usd(0),
      surcharge: usd(0),
      total: usd(5000),
      version: 1,
    });

    const quoted = await call('post', '/v2/admin/orders/MB-ORD-DESK-1/steps/quote').send({
      version: 1,
      data: { lines: [{ productRef: 'LOT-DESK-1', amountMinor: 5000 }], feeMinor: 100, validDays: 7 },
    });
    expect(quoted.status, JSON.stringify(quoted.body)).toBe(200);
    const { v2OrdersService } = await import('../src/modules/orders/v2.orders.service.js');
    const detail = await v2OrdersService.get(String(buyer._id), 'MB-ORD-DESK-1') as {
      version: number;
      quotation?: { number: string; total: { amountMinor: number } };
    };
    expect(detail.quotation?.number).toBeTruthy();
    expect(detail.quotation?.total.amountMinor).toBe(5100);
    const accepted = await v2OrdersService.acceptQuotation({
      userId: String(buyer._id),
      ref: 'MB-ORD-DESK-1',
      quotationNumber: detail.quotation!.number,
      version: detail.version,
    }) as { workflow?: { current?: { key?: string } } };
    expect(accepted.workflow?.current?.key).toBe('confirmed');

    const held = await call('post', '/v2/admin/orders/MB-ORD-DESK-1/hold').send({ type: 'changes', reason: 'Need a revised address' });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    const cleared = await call('post', '/v2/admin/orders/MB-ORD-DESK-1/hold').send({ clear: true });
    expect(cleared.body.hold).toBeNull();

    await OrderModel.create({
      reference: 'MB-ORD-DESK-SELL',
      userId: String(buyer._id),
      customerNo: 'C-9101',
      side: 'sell',
      status: 'active',
      source: { kind: 'sell_request' },
      workflow: { definition: 'sell.v2', stepKey: 'reviewed', stepIndex: 0, owner: 'platform', role: 'ops', enteredAt: new Date() },
      lines: [],
      sell: { mineralSlug: 'gold', name: 'Doré', qty: { measure: 'mass', unit: 'kg', base: 1000 }, grade: 'Au 90', form: 'Doré', details: 'Desk sell request for the workflow test.' },
      totalGrams: 1000,
      subtotal: usd(0),
      platformFee: usd(0),
      surcharge: usd(0),
      total: usd(0),
      version: 1,
    });
    const reviewedSell = await call('post', '/v2/admin/orders/MB-ORD-DESK-SELL/steps/reviewed').send({ version: 1, data: {} });
    expect(reviewedSell.status, JSON.stringify(reviewedSell.body)).toBe(200);
    const sellVersion = (await OrderModel.findOne({ reference: 'MB-ORD-DESK-SELL' }).lean())?.version ?? 0;
    const sellQuoted = await call('post', '/v2/admin/orders/MB-ORD-DESK-SELL/steps/quote').send({
      version: sellVersion,
      data: { offerMinor: 8000, validHours: 48 },
    });
    expect(sellQuoted.status, JSON.stringify(sellQuoted.body)).toBe(200);
    const sellDetail = await v2OrdersService.get(String(buyer._id), 'MB-ORD-DESK-SELL') as {
      version: number;
      quotation?: { number: string; total: { amountMinor: number } };
    };
    expect(sellDetail.quotation?.total.amountMinor).toBe(8000);
    const sellAccepted = await v2OrdersService.acceptQuotation({
      userId: String(buyer._id),
      ref: 'MB-ORD-DESK-SELL',
      quotationNumber: sellDetail.quotation!.number,
      version: sellDetail.version,
    }) as { workflow?: { current?: { key?: string } } };
    expect(sellAccepted.workflow?.current?.key).toBe('confirmed');

    const payOrder = await OrderModel.create({
      reference: 'MB-ORD-DESK-PAY',
      userId: String(buyer._id),
      side: 'buy',
      status: 'active',
      source: { kind: 'admin' },
      workflow: { definition: 'buy.v2', stepKey: 'payOk', stepIndex: 8, owner: 'platform', role: 'finance', enteredAt: new Date() },
      lines: [{ name: 'Desk Gold', productId: String(lot._id), grams: 100, unitPriceMinorE4PerGram: 1, lineTotalMinor: 1000 }],
      totalGrams: 100,
      subtotal: usd(1000),
      platformFee: usd(0),
      surcharge: usd(0),
      total: usd(1000),
      version: 2,
    });
    await PaymentModel.create({ orderId: String(payOrder._id), userId: String(buyer._id), method: 'bank_transfer', amount: usd(1000), status: 'submitted', attempt: 1, proofFileIds: [] });
    const confirmed = await call('post', '/v2/admin/payments/MB-ORD-DESK-PAY/confirm').send({ version: 2, confirmedRef: 'TRX-DESK' });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    const pay = await PaymentModel.findOne({ orderId: String(payOrder._id) }).lean();
    expect(pay?.status).toBe('confirmed');
    expect(pay?.confirmedRef).toBe('TRX-DESK');

    const rejectOrder = await OrderModel.create({
      reference: 'MB-ORD-DESK-REJ',
      userId: String(buyer._id),
      side: 'buy',
      status: 'active',
      source: { kind: 'admin' },
      workflow: { definition: 'buy.v2', stepKey: 'payOk', stepIndex: 8, owner: 'platform', role: 'finance', enteredAt: new Date() },
      lines: [{ name: 'Desk Gold', grams: 50, unitPriceMinorE4PerGram: 1, lineTotalMinor: 500 }],
      totalGrams: 50,
      subtotal: usd(500),
      platformFee: usd(0),
      surcharge: usd(0),
      total: usd(500),
      version: 1,
    });
    await PaymentModel.create({ orderId: String(rejectOrder._id), userId: String(buyer._id), method: 'upi', amount: usd(500), status: 'submitted', attempt: 1, proofFileIds: [] });
    const rejectedPay = await call('post', '/v2/admin/payments/MB-ORD-DESK-REJ/reject').send({ version: 1, reason: 'Reference does not match the account' });
    expect(rejectedPay.status, JSON.stringify(rejectedPay.body)).toBe(200);
    expect((await PaymentModel.findOne({ orderId: String(rejectOrder._id) }).lean())?.status).toBe('failed');

    await RefundModel.create({
      reference: 'MB-RF-DESK-1',
      orderId: String(order._id),
      userId: String(buyer._id),
      type: 'partial',
      amount: usd(1000),
      reason: 'other',
      note: 'Desk refund for the integration test.',
      destination: { method: 'original' },
      status: 'requested',
      decisions: [],
      approvals: [],
      dueBy: new Date(Date.now() + 86_400_000),
    });
    const reviewed = await call('post', '/v2/admin/refunds/MB-RF-DESK-1/review').send({});
    expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
    const approved = await call('post', '/v2/admin/refunds/MB-RF-DESK-1/approve').send({});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await RefundModel.findOne({ reference: 'MB-RF-DESK-1' }).lean())?.status).toBe('approved');

    const kyc = await KycSubmissionModel.create({
      publicId: 'kyc_desk_1',
      reference: 'MB-KYC-DESK-1',
      userId: buyer._id,
      status: 'pending',
      source: 'web',
      idTypeId: 'passport',
      requiredKinds: ['id_front'],
    });
    const decided = await call('post', `/v2/admin/kyc/${kyc._id}/decide`).send({ decision: 'resubmission_required', reason: 'The address page is unreadable' });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect((await KycSubmissionModel.findById(kyc._id).lean())?.status).toBe('resubmission_required');

    const note = await NotificationModel.create({
      userId: String(buyer._id),
      kind: 'order',
      event: 'order.stage_changed',
      title: 'Payment update',
      body: 'Could not deliver',
      channels: ['email'],
      data: { deliveryStatus: 'failed', attempts: 1 },
    });
    const retried = await call('post', `/v2/admin/notifications/${note._id}/retry`).send({});
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.status).toBe('delivered');
    const again = await call('post', `/v2/admin/notifications/${note._id}/retry`).send({});
    expect(again.status).toBe(409);

    await SupportTicketModel.create({
      reference: 'TCK-DESK-1',
      userId: String(buyer._id),
      topic: 'order',
      subject: 'Where is the shipment?',
      body: 'Please confirm the pickup date for this order.',
      status: 'open',
      messages: [{ author: 'user', authorName: 'Desk Buyer', body: 'Please confirm the pickup date for this order.', attachmentIds: [], at: new Date() }],
      version: 0,
    });
    const reply = await call('post', '/v2/admin/support/TCK-DESK-1/reply').send({ body: 'Pickup is booked for Friday morning.' });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body.messages).toBe(2);
    const second = await call('post', '/v2/admin/support/TCK-DESK-1/reply').send({ body: 'The partner will call before arrival.' });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    const resolved = await call('post', '/v2/admin/support/TCK-DESK-1/status').send({ status: 'resolved' });
    expect(resolved.body.status).toBe('resolved');
    const ticket = await SupportTicketModel.findOne({ reference: 'TCK-DESK-1' }).lean();
    expect(ticket?.messages.map((m) => m.body)).toEqual(expect.arrayContaining(['Pickup is booked for Friday morning.']));

    const uploaded = await call('post', '/v2/admin/documents/upload').send({
      orderRef: 'MB-ORD-DESK-1',
      filename: 'desk-note.pdf',
      contentType: 'application/pdf',
      contentBase64: PDF,
      type: 'consignment_note',
    });
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
    const downloaded = await call('get', `/v2/admin/documents/${uploaded.body.number}/download`);
    expect(downloaded.status, JSON.stringify(downloaded.body)).toBe(200);
    expect(Buffer.from(downloaded.body.contentBase64, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
    const reissued = await call('post', `/v2/admin/documents/${uploaded.body.number}/reissue`).send({ reason: 'Corrected the consignee name' });
    expect(reissued.status, JSON.stringify(reissued.body)).toBe(200);
    expect((await IssuedDocumentModel.findOne({ number: uploaded.body.number, status: 'replaced' }).lean())?.status).toBe('replaced');
    expect(await IssuedDocumentModel.countDocuments({ number: uploaded.body.number, status: 'issued' })).toBe(1);

    const partner = await call('post', '/v2/admin/partners').send({ name: 'Desk Haulage', type: 'logistics', regions: 'Nairobi', active: true });
    expect(partner.status, JSON.stringify(partner.body)).toBe(201);
    const paused = await call('patch', `/v2/admin/partners/${partner.body.partnerId}`).send({ name: 'Desk Haulage', active: false });
    expect(paused.body.status).toBe('suspended');
    const shipment = await ShipmentModel.create({
      reference: 'MB-SH-DESK-1',
      ownerIds: [String(buyer._id)],
      orderId: String(order._id),
      partnerId: partner.body.partnerId,
      status: 'booked',
      progressPercent: 0,
      events: [],
      documents: [],
    });
    const moved = await call('patch', '/v2/admin/shipments/MB-SH-DESK-1').send({ status: 'in_transit', location: 'Mombasa Road', note: 'Left the yard' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect((await ShipmentModel.findById(shipment._id).lean())?.currentLocation).toBe('Mombasa Road');
    const blockedDelete = await call('delete', `/v2/admin/partners/${partner.body.partnerId}`);
    expect(blockedDelete.status).toBe(409);

    const stock = await call('post', '/v2/admin/catalogue/lots/LOT-DESK-1/hold').send({ hold: true, reason: 'Waiting on a fresh assay' });
    expect(stock.status, JSON.stringify(stock.body)).toBe(200);
    expect((await ProductModel.findOne({ reference: 'LOT-DESK-1' }).lean())?.attributes?.onHold).toBe(true);
    const released = await call('post', '/v2/admin/catalogue/lots/LOT-DESK-1/hold').send({ hold: false });
    expect(released.body.onHold).toBe(false);

    const snap = await call('get', '/v2/admin/console');
    expect(snap.status).toBe(200);
    const thread = snap.body.threads.find((t: { id: string }) => t.id === 'TCK-DESK-1');
    expect(thread.msgs.length).toBeGreaterThan(1);
    const delivery = snap.body.deliveries.find((d: { id: string }) => d.id === String(note._id));
    expect(delivery.status).toBe('delivered');
    const methods = await request(app).get('/v2/reference/payment-methods').set('X-Client', 'web');
    expect(methods.status).toBe(200);
    expect(methods.body.items.find((m: { id: string }) => m.id === 'bank_transfer').enabled).toBe(true);

    const db = mongoose.connection.db!;
    await db.collection('orders').insertOne({
      userId: String(buyer._id),
      orderId: 'MB-OLD-1',
      mineralName: 'Copper',
      quantity: 1,
      unit: 't',
      totalDue: 20,
      type: 'buy',
      status: 'open',
      createdAt: new Date(),
    });
    const { planLegacyCheckout: plan } = await import('../src/modules/admin/v2/legacy-order-migration.js');
    const legacy = await db.collection('orders').findOne({ orderId: 'MB-OLD-1' });
    const planned = plan(legacy as unknown as { orderId: string; userId: string }, {
      existingRefs: new Set((await OrderModel.find({}, { reference: 1 }).lean()).map((o) => o.reference)),
      userIds: new Set([String(buyer._id)]),
      batch: 'test-batch',
    });
    expect(planned.action).toBe('insert');
    if (planned.action === 'insert') {
      await OrderModel.create(planned.document);
      const copy = await OrderModel.findOne({ reference: 'MB-OLD-1' }).lean();
      expect(copy?.migration).toMatchObject({ batch: 'test-batch', source: 'legacy-orders' });
      expect(copy?.totalGrams).toBe(1_000_000);
      const original = await db.collection('orders').findOne({ orderId: 'MB-OLD-1' });
      expect(original).toBeTruthy();
      await OrderModel.deleteOne({ reference: 'MB-OLD-1', 'migration.batch': 'test-batch' });
      expect(await OrderModel.findOne({ reference: 'MB-OLD-1' }).lean()).toBeNull();
      expect(await db.collection('orders').findOne({ orderId: 'MB-OLD-1' })).toBeTruthy();
    }
  }, 60_000);
});
