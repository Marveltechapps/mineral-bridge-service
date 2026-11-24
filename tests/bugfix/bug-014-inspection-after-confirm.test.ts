/**
 * BUG-014: after seller confirmation, inspection must be scheduled automatically.
 * @tags bugfix selling
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { references } from '../../src/common/utils/references.js';
import { OrderModel } from '../../src/models/order.model.js';
import { InspectionModel } from '../../src/models/workflow.model.js';
import { toPersistedWorkflow } from '../../src/modules/orders/v2.order-helpers.js';
import { startWorkflow } from '../../src/modules/workflow/workflow.service.js';
import { v2LifecycleService } from '../../src/modules/orders/v2.lifecycle.service.js';
import { clearDb, createUser, startDb, stopDb } from '../helpers/harness.js';

describe('bugfix inspection after seller confirm (BUG-014)', () => {
  beforeAll(async () => {
    await startDb();
  }, 120_000);
  afterAll(async () => {
    await stopDb();
  });
  beforeEach(async () => {
    await clearDb();
  });

  it('bug_014_seller_form_schedules_inspection', async () => {
    const userId = await createUser({ roles: ['seller'] });
    const money = { amountMinor: 0, currency: 'USD', display: 'USD 0.00' };
    const wf = toPersistedWorkflow(startWorkflow('sell.v2', 'form'));
    const order = await OrderModel.create({
      reference: await references.sellRequest(),
      userId,
      side: 'sell',
      status: 'active',
      stageIndex: 0,
      stageHistory: [],
      source: { kind: 'sell_request' },
      workflow: wf,
      lines: [],
      totalGrams: 1000,
      sell: {
        mineralSlug: 'gold',
        name: 'Gold',
        qty: { measure: 'mass', unit: 'kg', value: 1, base: 1000, grams: 1000 },
        grade: '80%',
        form: 'Raw',
        details: 'Test material for inspection flow',
        photoFileIds: [],
      },
      subtotal: money,
      platformFee: money,
      surcharge: money,
      total: money,
      paymentMethod: 'escrow',
      paymentTaken: false,
      settlement: { method: 'escrow', status: 'not_funded' },
      documents: [],
      version: 0,
    });

    const detail = await v2LifecycleService.sellerForm(userId, order.reference, {
      payout: { method: 'bank_transfer', bankName: 'Test Bank', accountNumber: '12345678' },
      inspectionSlot: { date: '2026-12-01', time: '10:00', address: 'Lagos warehouse' },
      confirmed: true,
      version: 0,
    });

    expect(detail.workflow?.current.key).toBe('inspect');
    const insp = await InspectionModel.findOne({ orderId: order._id }).lean();
    expect(insp).toBeTruthy();
    expect(insp?.status).toBe('scheduled');
    expect(insp?.schedule?.date).toBe('2026-12-01');
  });

  it('bug_014 edge: wrong step rejects seller form', async () => {
    const userId = await createUser({ roles: ['seller'] });
    const money = { amountMinor: 0, currency: 'USD', display: 'USD 0.00' };
    const wf = toPersistedWorkflow(startWorkflow('sell.v2', 'quoteOk'));
    const order = await OrderModel.create({
      reference: await references.sellRequest(),
      userId,
      side: 'sell',
      status: 'active',
      stageIndex: 0,
      stageHistory: [],
      source: { kind: 'sell_request' },
      workflow: wf,
      lines: [],
      totalGrams: 1000,
      subtotal: money,
      platformFee: money,
      surcharge: money,
      total: money,
      paymentMethod: 'escrow',
      paymentTaken: false,
      settlement: { method: 'escrow', status: 'not_funded' },
      documents: [],
      version: 0,
    });
    await expect(
      v2LifecycleService.sellerForm(userId, order.reference, {
        payout: { method: 'bank_transfer' },
        inspectionSlot: { date: '2026-12-01', time: '10:00', address: 'Lagos' },
        confirmed: true,
        version: 0,
      }),
    ).rejects.toMatchObject({ code: 'step/invalid' });
  });

  it('bug_014 neighbouring: acceptInspection still requires reportOk', async () => {
    const userId = await createUser({ roles: ['seller'] });
    const money = { amountMinor: 0, currency: 'USD', display: 'USD 0.00' };
    const wf = toPersistedWorkflow(startWorkflow('sell.v2', 'inspect'));
    const order = await OrderModel.create({
      reference: await references.sellRequest(),
      userId,
      side: 'sell',
      status: 'active',
      stageIndex: 0,
      stageHistory: [],
      source: { kind: 'sell_request' },
      workflow: wf,
      lines: [],
      totalGrams: 1000,
      subtotal: money,
      platformFee: money,
      surcharge: money,
      total: money,
      paymentMethod: 'escrow',
      paymentTaken: false,
      settlement: { method: 'escrow', status: 'not_funded' },
      documents: [],
      version: 0,
    });
    await expect(v2LifecycleService.acceptInspection(userId, order.reference, 0)).rejects.toMatchObject({
      code: 'step/invalid',
    });
  });
});
