import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { opaqueId } from '../src/common/utils/ids.js';
import { references } from '../src/common/utils/references.js';
import { OrderModel } from '../src/models/order.model.js';
import { v2OrdersService } from '../src/modules/orders/v2.orders.service.js';
import { clearDb, createUser, startDb, stopDb } from './helpers/harness.js';

describe('v2 order detail priceVariations', () => {
  beforeAll(async () => {
    await startDb();
  }, 120_000);
  afterAll(async () => {
    await stopDb();
  });
  beforeEach(async () => {
    await clearDb();
  });

  const money = (amountMinor: number) => ({ amountMinor, currency: 'USD', display: `USD ${(amountMinor / 100).toFixed(2)}` });

  it('includes mapped priceVariations (additive) and an empty list when none', async () => {
    const userId = await createUser();
    const base = {
      userId,
      side: 'sell' as const,
      status: 'active' as const,
      stageIndex: 0,
      stageHistory: [],
      source: { kind: 'sell_request' },
      lines: [],
      totalGrams: 1000,
      subtotal: money(0),
      platformFee: money(0),
      surcharge: money(0),
      total: money(100_000),
      paymentMethod: 'escrow' as const,
      paymentTaken: false,
      settlement: { method: 'escrow', status: 'not_funded' },
      documents: [],
      version: 0,
    };
    const empty = await OrderModel.create({ ...base, reference: await references.order() });
    const variationId = opaqueId('pvr');
    const withVar = await OrderModel.create({
      ...base,
      reference: await references.order(),
      priceVariations: [
        {
          _id: variationId,
          from: money(100_000),
          to: money(90_000),
          reason: 'grade',
          note: 'Assay came back lower',
          status: 'awaiting_seller',
          proposedBy: { kind: 'staff', id: 'adm_1' },
          proposedAt: new Date('2026-06-01T10:00:00.000Z'),
        },
      ],
    });

    const none = await v2OrdersService.get(userId, empty.reference);
    expect(none.priceVariations).toEqual([]);

    const detail = await v2OrdersService.get(userId, withVar.reference);
    expect(detail.priceVariations).toEqual([
      {
        id: variationId,
        from: money(100_000),
        to: money(90_000),
        status: 'awaiting_seller',
        reason: 'grade',
        note: 'Assay came back lower',
        proposedAt: '2026-06-01T10:00:00.000Z',
        decidedAt: null,
        decisionNote: null,
      },
    ]);
    expect(detail.reference).toBe(withVar.reference);
  });
});
