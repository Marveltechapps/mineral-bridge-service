import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, clearDb, createUser, MOBILE, seedProduct, startDb, stopDb, WEB } from './helpers/harness.js';
import { OrderModel, ProductModel } from '../src/models/index.js';
import { ordersService } from '../src/modules/orders/orders.service.js';

vi.mock('../src/modules/auth/auth.middleware.js', async () => await import('./helpers/fake-auth.js'));

const app = buildApp();
const delivery = {
  facilityName: 'Kano Refinery',
  streetAddress: '12 Bompai Road',
  city: 'Kano',
  country: 'NG',
  contactPerson: 'Amina Yusuf',
  contactPhone: '+2348012345678',
};

beforeAll(startDb);
afterAll(stopDb);
beforeEach(clearDb);

function mobileBody(productId: string, grams = 100) {
  return { productId, quantity: { value: grams, unit: 'g' }, delivery, acceptedTerms: true };
}

describe('POST /v1/orders idempotency (mobile)', () => {
  it('replays the same order for the same key + body and decrements stock once', async () => {
    const userId = await createUser();
    const product = await seedProduct({ availableGrams: 1000 });
    const key = 'order-key-0001';
    const send = () =>
      request(app).post('/v1/orders').set(MOBILE).set('x-test-user', userId).set('Idempotency-Key', key).send(mobileBody(product._id));

    const first = await send();
    expect(first.status).toBe(201);
    const second = await send();
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body.orderId ?? second.body.id).toBe(first.body.orderId ?? first.body.id);

    expect(await OrderModel.countDocuments({})).toBe(1);
    expect((await ProductModel.findById(product._id).lean())!.availableGrams).toBe(900);
  });

  it('rejects the same key with a different body (409 idempotency/key-reused)', async () => {
    const userId = await createUser();
    const product = await seedProduct();
    const key = 'order-key-0002';
    const ok = await request(app).post('/v1/orders').set(MOBILE).set('x-test-user', userId).set('Idempotency-Key', key).send(mobileBody(product._id, 100));
    expect(ok.status).toBe(201);
    const bad = await request(app).post('/v1/orders').set(MOBILE).set('x-test-user', userId).set('Idempotency-Key', key).send(mobileBody(product._id, 150));
    expect(bad.status).toBe(409);
    expect(bad.body.error?.code ?? bad.body.code).toBe('idempotency/key-reused');
    expect(await OrderModel.countDocuments({})).toBe(1);
  });

  it('requires the Idempotency-Key header', async () => {
    const userId = await createUser();
    const product = await seedProduct();
    const res = await request(app).post('/v1/orders').set(MOBILE).set('x-test-user', userId).send(mobileBody(product._id));
    expect(res.status).toBe(400);
  });

  it('creates exactly one order for concurrent duplicates', async () => {
    const userId = await createUser();
    const product = await seedProduct({ availableGrams: 1000 });
    const key = 'order-key-0003';
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app).post('/v1/orders').set(MOBILE).set('x-test-user', userId).set('Idempotency-Key', key).send(mobileBody(product._id)),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.orderId ?? r.body.id)).size).toBe(1);
    expect(await OrderModel.countDocuments({})).toBe(1);
    expect((await ProductModel.findById(product._id).lean())!.availableGrams).toBe(900);
  });

  it('different keys create distinct orders and never oversell', async () => {
    const userId = await createUser();
    const product = await seedProduct({ availableGrams: 300 });
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        request(app).post('/v1/orders').set(MOBILE).set('x-test-user', userId).set('Idempotency-Key', `order-key-multi-${i}`).send(mobileBody(product._id, 100)),
      ),
    );
    const created = results.filter((r) => r.status === 201).length;
    expect(created).toBe(3);
    expect(results.filter((r) => r.status !== 201).every((r) => r.status === 409 || r.status === 422)).toBe(true);
    expect((await ProductModel.findById(product._id).lean())!.availableGrams).toBe(0);
    expect(await OrderModel.countDocuments({})).toBe(3);
  });

  it('high contention: 24 concurrent orders on a 300 g lot create exactly 3 and leave it sold (regression: decrement/sold race)', async () => {
    const userId = await createUser();
    const product = await seedProduct({ availableGrams: 300 });
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        request(app).post('/v1/orders').set(MOBILE).set('x-test-user', userId).set('Idempotency-Key', `order-key-race-${i}`).send(mobileBody(product._id, 100)),
      ),
    );
    expect(results.filter((r) => r.status === 201).length).toBe(3);
    const after = (await ProductModel.findById(product._id).lean())!;
    expect(after.availableGrams).toBe(0);
    expect(after.status).toBe('sold');
    expect(await OrderModel.countDocuments({})).toBe(3);
  });

  it('service-level: same key returns the same orderId', async () => {
    const userId = await createUser();
    const product = await seedProduct();
    const input = {
      userId,
      client: 'mobile' as const,
      source: { kind: 'product' as const, productId: product._id, grams: 100 },
      delivery,
      idempotencyKey: 'order-key-0004',
    };
    const a = await ordersService.createOrder(input);
    const b = await ordersService.createOrder(input);
    expect(b.orderId).toBe(a.orderId);
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
  });
});

describe('POST /v1/orders (web contract + KYC gate)', () => {
  it('web: idempotent create, returns the web shape', async () => {
    const userId = await createUser();
    const lot = await seedProduct();
    const body = { lotId: lot._id, quantity: { value: 100, unit: 'g' }, paymentMethod: 'escrow' };
    const send = () => request(app).post('/v1/orders').set(WEB).set('x-test-user', userId).set('Idempotency-Key', 'web-order-0001').send(body);
    const a = await send();
    const b = await send();
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.order?.id).toBe(a.body.order?.id);
    expect(await OrderModel.countDocuments({})).toBe(1);
  });

  it('branches the KYC error code on the client', async () => {
    const userId = await createUser();
    const product = await seedProduct();
    const m = await request(app).post('/v1/orders').set(MOBILE).set('x-test-user', userId).set('x-test-kyc', 'none').set('Idempotency-Key', 'kyc-key-0001').send(mobileBody(product._id));
    expect(m.status).toBe(403);
    expect(m.body.error?.code ?? m.body.code).toBe('kyc/not-verified');
    const w = await request(app)
      .post('/v1/orders')
      .set(WEB)
      .set('x-test-user', userId)
      .set('x-test-kyc', 'none')
      .set('Idempotency-Key', 'kyc-key-0002')
      .send({ lotId: product._id, quantity: { value: 100, unit: 'g' }, paymentMethod: 'escrow' });
    expect(w.status).toBe(403);
    expect(w.body.error?.code ?? w.body.code).toBe('kyc/not-approved');
  });
});
