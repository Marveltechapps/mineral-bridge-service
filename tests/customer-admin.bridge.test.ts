import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Order } from '../src/models/trading.models.js';
import { User } from '../src/models/people.models.js';
import { buildApp, clearDb, createUser, MOBILE, seedProduct, startDb, stopDb } from './helpers/harness.js';

vi.mock('../src/modules/auth/auth.middleware.js', async () => await import('./helpers/fake-auth.js'));

const app = buildApp();

beforeAll(async () => {
  await startDb();
  await Promise.all([Order.init(), User.init()]);
});
afterAll(stopDb);
beforeEach(clearDb);

describe('customer order is visible to the admin collection', () => {
  it('projects a placed order onto the same reference the dashboard reads', async () => {
    const userId = await createUser({ email: 'buyer@example.com', profile: { fullName: 'Amina Yusuf', countryCode: 'NG' } });
    const product = await seedProduct({ availableGrams: 1000 });
    const res = await request(app)
      .post('/v1/orders')
      .set(MOBILE)
      .set('x-test-user', userId)
      .set('Idempotency-Key', 'bridge-order-1')
      .send({
        productId: product._id,
        quantity: { value: 100, unit: 'g' },
        delivery: {
          facilityName: 'Kano Refinery',
          streetAddress: '12 Bompai Road',
          city: 'Kano',
          country: 'NG',
          contactPerson: 'Amina Yusuf',
          contactPhone: '+2348012345678',
        },
        acceptedTerms: true,
      });
    expect(res.status).toBe(201);
    const adminUser = await User.findOne({ userId }).lean();
    expect(adminUser?.name).toBe('Amina Yusuf');
    const adminOrders = await Order.find({ counterpartyId: userId }).lean();
    expect(adminOrders).toHaveLength(1);
    expect(adminOrders[0]?.mineral.name).toBe('Gold dore bar');
    expect(adminOrders[0]?.stage).toBe('verification');
  });
});
