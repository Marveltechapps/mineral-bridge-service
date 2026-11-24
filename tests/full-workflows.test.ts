import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMemoryReplSet, stopMemoryReplSet } from './setup.js';

const PASSWORD = 'Correct-Horse-9!Battery';

describe('full buy and sell workflows on an isolated database', () => {
  let app: Express;

  beforeAll(async () => {
    await startMemoryReplSet('mb_full_flow');
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    const { resetEnvCache } = await import('../src/config/env.js');
    resetEnvCache();
    const { connectDatabase } = await import('../src/config/database.js');
    await connectDatabase();
    const { createApp } = await import('../src/app.js');
    app = createApp();
    const { createStaff } = await import('../src/modules/staff/staff.service.js');
    await createStaff({ email: 'flow.ceo@mineralbridge.test', password: PASSWORD, name: 'Flow CEO', roleId: 'ROLE-CEO' });
  }, 120_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await stopMemoryReplSet();
  });

  it('walks buy and sell from quotation through completion, and persists auction, template, invite and invoice', async () => {
    const agent = request.agent(app);
    const sign = await agent.post('/v2/admin/auth/sign-in').set('X-Client', 'admin').send({
      email: 'flow.ceo@mineralbridge.test', password: PASSWORD,
    });
    expect(sign.status, JSON.stringify(sign.body)).toBe(200);
    const csrf = String(sign.headers['x-csrf-token'] || '');
    const call = (method: 'get' | 'post' | 'patch' | 'delete', url: string) =>
      agent[method](url).set('X-Client', 'admin').set('X-CSRF-Token', csrf);

    const { UserModel } = await import('../src/modules/users/user.model.js');
    const { ProductModel } = await import('../src/models/catalog.model.js');
    const { OrderModel } = await import('../src/models/order.model.js');
    const { FileModel } = await import('../src/models/file.model.js');
    const { PaymentModel, InspectionModel, IssuedDocumentModel } = await import('../src/models/workflow.model.js');
    const { ShipmentModel } = await import('../src/models/contract-lc.model.js');
    const { v2OrdersService } = await import('../src/modules/orders/v2.orders.service.js');
    const { v2ContractService } = await import('../src/modules/orders/v2.contract.service.js');
    const { v2PaymentsService } = await import('../src/modules/orders/v2.payments.service.js');
    const { v2LifecycleService } = await import('../src/modules/orders/v2.lifecycle.service.js');

    const trader = await UserModel.create({
      customerNo: 'C-9201',
      email: 'flow.trader@example.com',
      phone: '+254711920001',
      roles: ['both'],
      kycStatus: 'verified',
      accountStatus: 'active',
      profile: { fullName: 'Workflow Trader', countryCode: 'KE' },
    });
    const userId = String(trader._id);
    const photos = await FileModel.create([0, 1, 2].map((n) => ({
      ownerId: userId,
      purpose: 'sell_photo',
      filename: `ore-${n}.jpg`,
      contentType: 'image/jpeg',
      bytes: 1200,
      storageKey: `test/ore-${n}.jpg`,
      visibility: 'private',
    })));
    const receiptPhoto = await FileModel.create({
      ownerId: userId,
      purpose: 'delivery_photo',
      filename: 'receipt.jpg',
      contentType: 'image/jpeg',
      bytes: 800,
      storageKey: 'test/receipt.jpg',
      visibility: 'private',
    });
    const lot = await ProductModel.create({
      reference: 'LOT-FLOW-1',
      name: 'Flow Gold',
      typeSlug: 'gold',
      categorySlug: 'precious',
      mineralCode: 'AU',
      origin: { country: 'KE' },
      status: 'active',
      availableGrams: 1_000_000,
      minOrderGrams: 100,
      unitPriceMinorE4PerGram: 10_000,
      seller: { name: 'Mineral Bridge', tier: 'mineral_bridge', verified: true },
      attributes: {},
    });

    const at = async (ref: string) => {
      const order = await OrderModel.findOne({ reference: ref }).lean();
      if (!order?.workflow) throw new Error(`missing workflow for ${ref}`);
      return { version: order.version ?? 0, key: order.workflow.stepKey, status: order.status };
    };
    const advance = async (ref: string, data: Record<string, unknown> = {}) => {
      const cur = await at(ref);
      const res = await call('post', `/v2/admin/orders/${encodeURIComponent(ref)}/steps/${cur.key}`).send({ version: cur.version, data });
      expect(res.status, `${cur.key} ${JSON.stringify(res.body)}`).toBe(200);
      return at(ref);
    };

    const buy = await v2OrdersService.createBuy({
      userId,
      items: [{ productRef: 'LOT-FLOW-1', qty: { value: 100, unit: 'g' } }],
      delivery: { org: 'Flow Refinery', street: '1 Mine Road', city: 'Nairobi', region: 'Nairobi', country: 'KE', contact: 'Workflow Trader', mobile: '+254711920001' },
    });
    const buyRef = buy.reference;
    expect((await at(buyRef)).key).toBe('accepted');
    expect((await advance(buyRef)).key).toBe('quote');
    expect((await advance(buyRef, { lines: [{ productRef: 'LOT-FLOW-1', amountMinor: 5000 }], feeMinor: 100, validDays: 7 })).key).toBe('quoteOk');
    const quoted = await v2OrdersService.get(userId, buyRef) as { version: number; quotation?: { number: string; total: { amountMinor: number } } };
    expect(quoted.quotation?.total.amountMinor).toBe(5100);
    const accepted = await v2OrdersService.acceptQuotation({ userId, ref: buyRef, quotationNumber: quoted.quotation!.number, version: quoted.version }) as { workflow?: { current?: { key?: string } } };
    expect(accepted.workflow?.current?.key).toBe('confirmed');
    expect((await advance(buyRef)).key).toBe('contract');
    const contract = await v2ContractService.getOrCreate(userId, buyRef);
    await v2ContractService.sign(userId, buyRef, {
      documentHash: contract.documentHash,
      nameTyped: 'Workflow Trader',
      readConfirmed: true,
      version: (await at(buyRef)).version,
    });
    expect((await at(buyRef)).key).toBe('contractMb');
    expect((await advance(buyRef, { signatory: 'Flow CEO' })).key).toBe('paid');
    await v2PaymentsService.btcQuote(userId, buyRef);
    await v2PaymentsService.submit(userId, buyRef, { method: 'btc', btcTxid: 'a'.repeat(64), version: (await at(buyRef)).version });
    expect((await at(buyRef)).key).toBe('payOk');
    expect((await advance(buyRef, { confirmedRef: 'TRX-FLOW-BUY' })).key).toBe('assigned');
    const partner = await call('post', '/v2/admin/partners').send({ name: 'Flow Hauliers', type: 'logistics' });
    expect(partner.status, JSON.stringify(partner.body)).toBe(201);
    const partnerId = String(partner.body.partnerId || partner.body.id);
    expect((await advance(buyRef, { partnerId, mode: 'road' })).key).toBe('picked');
    expect((await advance(buyRef, { location: 'Nairobi yard' })).key).toBe('transit');
    expect((await advance(buyRef, { location: 'Mombasa Road' })).key).toBe('delivered');
    expect((await advance(buyRef, { location: 'Buyer gate' })).key).toBe('receipt');
    await v2LifecycleService.acceptDelivery(userId, buyRef, {
      qtyReceived: { value: 100, unit: 'g' },
      condition: 'good',
      photoFileIds: [String(receiptPhoto._id)],
      version: (await at(buyRef)).version,
    });
    const buyDone = await at(buyRef);
    expect(buyDone.key).toBe('done');
    expect(buyDone.status).toBe('completed');
    const buyPay = await PaymentModel.findOne({ confirmedRef: 'TRX-FLOW-BUY' }).lean();
    expect(buyPay?.status).toBe('confirmed');
    const buyShip = await ShipmentModel.findOne({ orderId: String((await OrderModel.findOne({ reference: buyRef }).lean())?._id) }).lean();
    expect(buyShip?.status).toBe('delivered');

    const sell = await v2OrdersService.createSell({
      userId,
      sell: {
        mineral: 'gold',
        name: 'Flow doré',
        qty: { value: 1, unit: 'kg' },
        grade: 'Au 90%',
        form: 'Doré bar',
        details: 'One kilogram doré bar from a verified site.',
        photoFileIds: photos.map((file) => String(file._id)),
      },
    });
    const sellRef = sell.reference;
    expect((await at(sellRef)).key).toBe('reviewed');
    expect((await advance(sellRef)).key).toBe('quote');
    expect((await advance(sellRef, { offerMinor: 8000, validHours: 48 })).key).toBe('quoteOk');
    const sellQuote = await v2OrdersService.get(userId, sellRef) as { version: number; quotation?: { number: string } };
    const sellAccepted = await v2OrdersService.acceptQuotation({
      userId, ref: sellRef, quotationNumber: sellQuote.quotation!.number, version: sellQuote.version,
    }) as { workflow?: { current?: { key?: string } } };
    expect(sellAccepted.workflow?.current?.key).toBe('confirmed');
    expect((await advance(sellRef)).key).toBe('contract');
    const sellContract = await v2ContractService.getOrCreate(userId, sellRef);
    await v2ContractService.sign(userId, sellRef, {
      documentHash: sellContract.documentHash,
      nameTyped: 'Workflow Trader',
      readConfirmed: true,
      version: (await at(sellRef)).version,
    });
    expect((await at(sellRef)).key).toBe('contractMb');
    expect((await advance(sellRef, { signatory: 'Flow CEO' })).key).toBe('form');
    await v2LifecycleService.sellerForm(userId, sellRef, {
      payout: { method: 'bank_transfer', account: '000111' },
      inspectionSlot: { date: '2026-12-01', time: '09:00', address: 'Nairobi yard' },
      confirmed: true,
      version: (await at(sellRef)).version,
    });
    // BUG-014: seller confirmation auto-schedules inspection and lands on `inspect`
    // (previously stopped at formOk and required manual schedule + inspect advances).
    expect((await at(sellRef)).key).toBe('inspect');
    expect((await advance(sellRef, { weight: { value: 1, unit: 'kg' }, result: 'matches', notes: 'Seals intact' })).key).toBe('sgs');
    expect((await advance(sellRef, { certificateNo: 'SGS-FLOW-1', grade: 'Au 90%', net: { value: 1, unit: 'kg' }, result: 'compliant' })).key).toBe('reportOk');
    await v2LifecycleService.acceptInspection(userId, sellRef, (await at(sellRef)).version);
    expect((await at(sellRef)).key).toBe('approved');
    expect((await advance(sellRef)).key).toBe('payout');
    expect((await advance(sellRef, { confirmedRef: 'PAY-FLOW-SELL' })).key).toBe('ship');
    expect((await advance(sellRef, { location: 'Vault' })).key).toBe('delivered');
    expect((await advance(sellRef, { location: 'Vault received' })).status).toBe('completed');
    const inspection = await InspectionModel.findOne({ orderId: String((await OrderModel.findOne({ reference: sellRef }).lean())?._id) }).lean();
    expect(inspection?.status).toBe('accepted');
    expect(inspection?.report?.certificateNo).toBe('SGS-FLOW-1');

    const invoice = await call('post', `/v2/admin/orders/${encodeURIComponent(buyRef)}/invoice`).send({ rate: 16 });
    expect(invoice.status, JSON.stringify(invoice.body)).toBe(201);
    const storedInvoice = await IssuedDocumentModel.findOne({ number: invoice.body.number }).lean();
    expect(storedInvoice?.type).toBe('tax_invoice');
    expect(storedInvoice?.status).toBe('issued');

    const auction = await call('post', '/v2/admin/auctions').send({
      name: 'Flow Gold auction',
      quantityGrams: 200,
      currency: 'USD',
      startingBidMinor: 10000,
      stepMinor: 500,
      opensAt: new Date(Date.now() + 3600_000).toISOString(),
      closesAt: new Date(Date.now() + 86_400_000).toISOString(),
      productId: String(lot._id),
    });
    expect(auction.status, JSON.stringify(auction.body)).toBe(201);

    const template = await call('post', '/v2/admin/templates').send({ name: 'Flow consignment', body: 'Consignment {{number}} for {{customer_name}}' });
    expect(template.status, JSON.stringify(template.body)).toBe(201);
    const templateUpdate = await call('post', '/v2/admin/templates').send({ id: template.body.id, name: 'Flow consignment', body: 'Consignment {{number}} revised' });
    expect(templateUpdate.status, JSON.stringify(templateUpdate.body)).toBe(200);
    expect(templateUpdate.body.ver).toBe(2);

    const invite = await call('post', '/v2/admin/admins/invite').send({ name: 'Flow Support', email: 'flow.support@mineralbridge.test', roleKey: 'support' });
    expect(invite.status, JSON.stringify(invite.body)).toBe(201);
    const invited = request.agent(app);
    const invitedSign = await invited.post('/v2/admin/auth/sign-in').set('X-Client', 'admin').send({
      email: 'flow.support@mineralbridge.test', password: invite.body.temporaryPassword,
    });
    expect(invitedSign.status, JSON.stringify(invitedSign.body)).toBe(200);

    const page = await call('get', '/v2/admin/console?page=1&pageSize=1');
    expect(page.status).toBe(200);
    expect(page.body.orders).toHaveLength(1);
    expect(page.body.totals.orders).toBeGreaterThanOrEqual(2);
    expect(page.body.pageSize).toBe(1);
    const pageTwo = await call('get', '/v2/admin/console?page=2&pageSize=1');
    expect(pageTwo.body.orders).toHaveLength(1);
    expect(pageTwo.body.orders[0].id).not.toBe(page.body.orders[0].id);
  }, 120_000);
});
