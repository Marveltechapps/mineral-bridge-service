/**
 * BUG-004 / BUG-006 — catalogue list & detail availability + lab exposure.
 */
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createV2Router } from '../src/app-clients/v2/routes.js';
import { errorHandler, notFoundHandler } from '../src/common/middleware/error-handler.js';
import { requestContext } from '../src/common/middleware/request-context.js';
import { clearDb, seedProduct, startDb, stopDb } from './helpers/harness.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use('/v2', createV2Router());
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const MOBILE = { 'x-client': 'mobile' } as const;

describe('bugfix catalogue availability', () => {
  beforeAll(async () => {
    await startDb();
  }, 120_000);
  afterAll(async () => {
    await stopDb();
  });
  beforeEach(async () => {
    await clearDb();
  });

  it('bug_004_active_zero_grams_not_sold_out', async () => {
    const product = await seedProduct({ status: 'active', availableGrams: 0, attributes: { sourceSheet: true } });
    const res = await request(buildApp()).get('/v2/catalogue/products').set(MOBILE);
    expect(res.status).toBe(200);
    const row = res.body.items.find((x: { productRef: string }) => x.productRef === product.reference);
    expect(row).toBeDefined();
    expect(row.soldOut).toBe(false);
    expect(row.availableOnRequest).toBe(true);
    expect(row.inventoryTracked).toBe(false);
  });

  it('bug_004_tracked_stock_not_on_request', async () => {
    const product = await seedProduct({ status: 'active', availableGrams: 500 });
    const res = await request(buildApp()).get('/v2/catalogue/products').set(MOBILE);
    const row = res.body.items.find((x: { productRef: string }) => x.productRef === product.reference);
    expect(row?.soldOut).toBe(false);
    expect(row?.availableOnRequest).toBe(false);
    expect(row?.inventoryTracked).toBe(true);
  });

  it('bug_004_sold_status_is_sold_out', async () => {
    const product = await seedProduct({ status: 'sold', availableGrams: 0 });
    await seedProduct({ status: 'active', availableGrams: 100, reference: 'MBP-OTHER-ACTIVE' });
    const res = await request(buildApp()).get(`/v2/catalogue/products/${product.reference}`).set(MOBILE);
    expect(res.status).toBe(200);
    expect(res.body.soldOut).toBe(true);
    expect(res.body.availableOnRequest).toBe(false);
  });

  it('bug_006_detail_exposes_lab_from_product_fields', async () => {
    const product = await seedProduct({
      status: 'active',
      availableGrams: 0,
      lab: { name: 'SGS', certificateNo: 'SGS-NG-26-4471' },
      verified: true,
    });
    const res = await request(buildApp()).get(`/v2/catalogue/products/${product.reference}`).set(MOBILE);
    expect(res.status).toBe(200);
    expect(res.body.lab).toEqual({ name: 'SGS', certificateNo: 'SGS-NG-26-4471' });
  });

  it('bug_006_neighbouring_list_still_returns_active_lots', async () => {
    await seedProduct({ status: 'active', availableGrams: 0, attributes: { sourceSheet: true } });
    const tracked = await seedProduct({ status: 'active', availableGrams: 2000, reference: 'MBP-TRACKED-2' });
    const res = await request(buildApp()).get('/v2/catalogue/products').set(MOBILE);
    expect(res.body.items.some((x: { productRef: string }) => x.productRef === tracked.reference)).toBe(true);
    expect(res.body.items.length).toBeGreaterThanOrEqual(2);
  });
});