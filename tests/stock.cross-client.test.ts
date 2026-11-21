/**
 * Cross-client stock accounting: a customer buy order (mobile v1 and web v2) followed by the admin
 * desk "accepted" step must decrement lot stock exactly once.
 */
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMemoryReplSet, stopMemoryReplSet } from './setup.js';

const PASSWORD = 'Correct-Horse-9!Battery';

describe('stock is reserved exactly once across customer creation and admin acceptance', () => {
  let app: Express;
  let call: (method: 'get' | 'post', url: string) => request.Test;

  beforeAll(async () => {
    await startMemoryReplSet('mb_stock_cross');
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    const { resetEnvCache } = await import('../src/config/env.js');
    resetEnvCache();
    const { connectDatabase } = await import('../src/config/database.js');
    await connectDatabase();
    const { createApp } = await import('../src/app.js');
    app = createApp();
    const { createStaff } = await import('../src/modules/staff/staff.service.js');
    await createStaff({ email: 'stock.ceo@mineralbridge.test', password: PASSWORD, name: 'Stock CEO', roleId: 'ROLE-CEO' });
    const agent = request.agent(app);
    const sign = await agent.post('/v2/admin/auth/sign-in').set('X-Client', 'admin').send({ email: 'stock.ceo@mineralbridge.test', password: PASSWORD });
    expect(sign.status).toBe(200);
    const csrf = String(sign.headers['x-csrf-token'] || '');
    call = (method, url) => agent[method](url).set('X-Client', 'admin').set('X-CSRF-Token', csrf);
  }, 120_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await stopMemoryReplSet();
  });

  async function seed(ref: string) {
    const { UserModel } = await import('../src/modules/users/user.model.js');
    const { ProductModel } = await import('../src/models/catalog.model.js');
    const n = Math.floor(Math.random() * 1e6);
    const user = await UserModel.create({
      customerNo: `C-${n}`, email: `stock${n}@example.com`, phone: `+2547${String(n).padStart(8, '0')}`,
      roles: ['both'], kycStatus: 'verified', accountStatus: 'active', profile: { fullName: 'Stock Buyer', countryCode: 'KE' },
    });
    const lot = await ProductModel.create({
      reference: ref, name: 'Stock Gold', typeSlug: 'gold', categorySlug: 'precious', mineralCode: 'AU',
      origin: { country: 'KE' }, status: 'active', availableGrams: 1000, minOrderGrams: 100, unitPriceMinorE4PerGram: 10_000,
      seller: { name: 'Mineral Bridge', tier: 'mineral_bridge', verified: true }, attributes: {},
    });
    return { userId: String(user._id), lotId: String(lot._id), ProductModel };
  }

  async function acceptAtDesk(orderRef: string) {
    const { OrderModel } = await import('../src/models/order.model.js');
    const o = await OrderModel.findOne({ $or: [{ reference: orderRef }, { _id: orderRef }] }).lean();
    expect(o, 'order exists').toBeTruthy();
    const key = o!.workflow?.stepKey;
    return { key, res: key ? await call('post', `/v2/admin/orders/${encodeURIComponent(o!.reference)}/steps/${key}`).send({ version: o!.version ?? 0, data: {} }) : null };
  }

  it('web (v2) buy: 0 g at creation, 100 g at desk acceptance', async () => {
    const { userId, ProductModel } = await seed('LOT-STOCK-WEB');
    const { v2OrdersService } = await import('../src/modules/orders/v2.orders.service.js');
    const buy = await v2OrdersService.createBuy({
      userId,
      items: [{ productRef: 'LOT-STOCK-WEB', qty: { value: 100, unit: 'g' } }],
      delivery: { org: 'R', street: '1 Road', city: 'Nairobi', region: 'Nairobi', country: 'KE', contact: 'B', mobile: '+254711000000' },
    });
    expect((await ProductModel.findOne({ reference: 'LOT-STOCK-WEB' }).lean())!.availableGrams).toBe(1000);
    const { key, res } = await acceptAtDesk(buy.reference);
    expect(key).toBe('accepted');
    expect(res!.status, JSON.stringify(res!.body)).toBe(200);
    expect((await ProductModel.findOne({ reference: 'LOT-STOCK-WEB' }).lean())!.availableGrams).toBe(900);
  });

  it('mobile (v1) buy: 100 g at creation and no second decrement if the desk accepts it', async () => {
    const { userId, lotId, ProductModel } = await seed('LOT-STOCK-MOB');
    const { ordersService } = await import('../src/modules/orders/orders.service.js');
    const orderId = await ordersService.createOrderOnce({
      userId, client: 'mobile', source: { kind: 'product', productId: lotId, grams: 100 },
      delivery: { facilityName: 'R', streetAddress: '1 Road', city: 'Nairobi', country: 'KE', contactPerson: 'B', contactPhone: '+254711000000' },
    } as never);
    expect((await ProductModel.findById(lotId).lean())!.availableGrams).toBe(900);
    const { key, res } = await acceptAtDesk(orderId);
    if (key === 'accepted') {
      expect(res!.status, JSON.stringify(res!.body)).toBe(200);
    }
    expect((await ProductModel.findById(lotId).lean())!.availableGrams).toBe(900);
  });

  it('POST /v2/orders honours Idempotency-Key: replay, concurrent double-submit, and key reuse with a different body', async () => {
    const { userId } = await seed('LOT-STOCK-IDEM');
    const { issueCustomerTokens } = await import('../src/modules/auth/auth.service.js');
    const { UserModel } = await import('../src/modules/users/user.model.js');
    const { OrderModel } = await import('../src/models/order.model.js');
    const u = (await UserModel.findById(userId).lean())!;
    const { accessToken } = await issueCustomerTokens({ id: userId, roles: (u as { roles?: string[] }).roles ?? ['both'] } as never, 'web');
    const delivery = { org: 'Idem Refinery', street: '1 Mine Road', city: 'Nairobi', region: 'Nairobi', country: 'KE', contact: 'Idem Buyer', mobile: '+254711000000' };
    const body = (value: number) => ({ kind: 'buy', items: [{ productRef: 'LOT-STOCK-IDEM', qty: { value, unit: 'g' } }], delivery });
    const post = (key: string, value = 100) => request(app).post('/v2/orders')
      .set('X-Client', 'mineralbridge-web/0.1.0').set('Authorization', `Bearer ${accessToken}`).set('Idempotency-Key', key).send(body(value));

    const first = await post('v2-idem-key-0001');
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const replay = await post('v2-idem-key-0001');
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.body.reference).toBe(first.body.reference);

    const burst = await Promise.all(Array.from({ length: 6 }, () => post('v2-idem-key-0002')));
    expect(burst.map((r) => r.status)).toEqual(Array(6).fill(201));
    expect(new Set(burst.map((r) => r.body.reference)).size).toBe(1);

    const reused = await post('v2-idem-key-0001', 200);
    expect(reused.status).toBe(409);
    expect(await OrderModel.countDocuments({ userId })).toBe(2);
  });
});
