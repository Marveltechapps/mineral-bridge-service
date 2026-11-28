/**
 * Catalogue Lots bulk delete: hard-delete minerals with no business history,
 * archive minerals that orders and other records still reference.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bulkDeleteConsoleLots } from '../src/modules/admin/v2/admin-lot-bulk.service.js';
import { AuctionModel } from '../src/models/auction.model.js';
import { CartModel } from '../src/models/cart.model.js';
import { ProductModel } from '../src/models/catalog.model.js';
import { ContractModel } from '../src/models/contract-lc.model.js';
import { OrderModel } from '../src/models/order.model.js';
import { NegotiationModel } from '../src/models/web-trade.model.js';
import { InspectionModel, PaymentModel } from '../src/models/workflow.model.js';
import { clearDb, seedProduct, startDb, stopDb } from './helpers/harness.js';

const money = { amountMinor: 1000, currency: 'USD' };

async function seedOrder(productId: string, side: 'buy' | 'sell', reference: string) {
  return OrderModel.create({
    reference,
    userId: 'usr_bulk',
    side,
    source: { kind: side === 'sell' ? 'sell_request' : 'product', refId: productId },
    lines: [{ productId, name: 'Linked mineral', grams: 100, unitPriceMinorE4PerGram: 1, lineTotalMinor: 100 }],
    totalGrams: 100,
    subtotal: money,
    platformFee: money,
    surcharge: money,
    total: money,
  });
}

describe('catalogue bulk delete', () => {
  beforeAll(async () => {
    await startDb();
  }, 120_000);
  afterAll(async () => {
    await stopDb();
  });
  beforeEach(async () => {
    await clearDb();
  });

  it('deletes one mineral and leaves the others', async () => {
    const target = await seedProduct({ reference: 'MBP-ONE', status: 'draft', attributes: { sourceSheet: false } });
    const other = await seedProduct({ reference: 'MBP-KEEP', status: 'active' });
    const result = await bulkDeleteConsoleLots([target.reference]);
    expect(result.deleted).toEqual(['MBP-ONE']);
    expect(result.archived).toEqual([]);
    expect(await ProductModel.countDocuments({ reference: 'MBP-ONE' })).toBe(0);
    expect(await ProductModel.countDocuments({ reference: other.reference })).toBe(1);
  });

  it('deletes several minerals and ignores duplicate ids', async () => {
    const a = await seedProduct({ reference: 'MBP-A', status: 'draft' });
    const b = await seedProduct({ reference: 'MBP-B', status: 'active', attributes: { sourceSheet: true } });
    const keep = await seedProduct({ reference: 'MBP-C', status: 'sold' });
    const result = await bulkDeleteConsoleLots([a.reference, b.reference, a.reference]);
    expect(result.selected).toBe(2);
    expect(result.deleted.sort()).toEqual(['MBP-A', 'MBP-B']);
    expect(await ProductModel.countDocuments({ reference: { $in: ['MBP-A', 'MBP-B'] } })).toBe(0);
    expect(await ProductModel.countDocuments({ reference: keep.reference })).toBe(1);
  });

  it('selects and deletes 284 minerals across the catalogue, keeping two that were left out', async () => {
    const docs = await ProductModel.insertMany(Array.from({ length: 284 }, (_, i) => ({
      reference: `MBP-284-${String(i).padStart(3, '0')}`,
      name: `Mineral ${i}`,
      typeSlug: 'gold-dore',
      categorySlug: 'precious-metals',
      mineralCode: 'AU',
      origin: { country: 'NG' },
      availableGrams: 1000,
      unitPriceMinorE4PerGram: 100,
      status: i % 4 === 0 ? 'active' : i % 4 === 1 ? 'draft' : i % 4 === 2 ? 'sold' : 'withdrawn',
      attributes: { sourceSheet: i % 2 === 0 },
    })));
    expect(docs).toHaveLength(284);
    const skipped = new Set(['MBP-284-000', 'MBP-284-010', 'MBP-284-020']);
    const selected = docs.map((doc) => doc.reference).filter((id) => !skipped.has(id));
    expect(selected).toHaveLength(281);
    const result = await bulkDeleteConsoleLots(selected);
    expect(result.deleted).toHaveLength(281);
    expect(result.archived).toHaveLength(0);
    expect(await ProductModel.countDocuments({})).toBe(3);
    expect(await ProductModel.countDocuments({ reference: { $in: [...skipped] } })).toBe(3);
    expect(await ProductModel.countDocuments({ reference: 'MBP-284-001' })).toBe(0);
  });

  it('archives minerals with orders, auctions, inspections, contracts, or payments and keeps that history', async () => {
    const bought = await seedProduct({ reference: 'MBP-BUY', status: 'active' });
    const sold = await seedProduct({ reference: 'MBP-SELL', status: 'active' });
    const auctioned = await seedProduct({ reference: 'MBP-AUC', status: 'active' });
    const negotiated = await seedProduct({ reference: 'MBP-NEG', status: 'draft' });
    const free = await seedProduct({ reference: 'MBP-FREE', status: 'draft', attributes: { sourceSheet: true } });
    const untouched = await seedProduct({ reference: 'MBP-SAFE', status: 'active' });

    const buy = await seedOrder(String(bought._id), 'buy', 'MB-BUY-BULK-1');
    const sell = await seedOrder(String(sold._id), 'sell', 'MB-SELL-BULK-1');
    await PaymentModel.create({ orderId: String(buy._id), userId: 'usr_bulk', method: 'wire', amount: money });
    await InspectionModel.create({
      orderId: String(sell._id),
      type: 'third_party',
      schedule: {
        date: '2026-11-28',
        time: '10:00',
        location: 'Lagos',
        scheduledBy: { kind: 'staff', id: 'stf_1', name: 'Admin' },
        at: new Date(),
      },
    });
    await ContractModel.create({
      reference: 'CTR-BULK-1',
      buyerId: 'usr_buyer',
      sellerId: 'usr_seller',
      orderId: String(buy._id),
      terms: { lotDescription: 'Gold' },
    });
    const opens = new Date();
    const closes = new Date(opens.getTime() + 86_400_000);
    await AuctionModel.create({
      reference: 'AUC-BULK-1',
      name: 'Gold auction',
      productId: String(auctioned._id),
      quantityGrams: 100,
      startingBid: money,
      minimumIncrement: money,
      opensAt: opens,
      closesAt: closes,
      originalClosesAt: closes,
    });
    await NegotiationModel.create({ reference: 'NEG-BULK-1', buyerId: 'usr_buyer', lotId: negotiated.reference });
    await CartModel.create({
      userId: 'usr_cart',
      items: [{ productId: String(free._id), grams: 50 }, { productId: String(bought._id), grams: 20 }],
    });

    const result = await bulkDeleteConsoleLots([
      bought.reference,
      sold.reference,
      auctioned.reference,
      negotiated.reference,
      free.reference,
      free.reference,
    ]);

    expect(result.selected).toBe(5);
    expect(result.deleted).toEqual(['MBP-FREE']);
    expect(result.archived.sort()).toEqual(['MBP-AUC', 'MBP-BUY', 'MBP-NEG', 'MBP-SELL']);
    expect(await ProductModel.countDocuments({ reference: 'MBP-FREE' })).toBe(0);
    const kept = await ProductModel.find({ reference: { $in: ['MBP-BUY', 'MBP-SELL', 'MBP-AUC', 'MBP-NEG'] } }).select('reference status').lean();
    expect(kept.map((row) => row.status).sort()).toEqual(['withdrawn', 'withdrawn', 'withdrawn', 'withdrawn']);
    expect(await ProductModel.countDocuments({ reference: untouched.reference, status: 'active' })).toBe(1);
    expect(await OrderModel.countDocuments({ reference: { $in: [buy.reference, sell.reference] } })).toBe(2);
    expect(await PaymentModel.countDocuments({ orderId: String(buy._id) })).toBe(1);
    expect(await InspectionModel.countDocuments({ orderId: String(sell._id) })).toBe(1);
    expect(await ContractModel.countDocuments({ reference: 'CTR-BULK-1' })).toBe(1);
    expect(await AuctionModel.countDocuments({ reference: 'AUC-BULK-1' })).toBe(1);
    expect(await NegotiationModel.countDocuments({ reference: 'NEG-BULK-1' })).toBe(1);
    const cart = await CartModel.findOne({ userId: 'usr_cart' }).lean();
    expect(cart?.items ?? []).toHaveLength(0);
  });

  it('does nothing to the database when the id list is empty of real minerals', async () => {
    const keep = await seedProduct({ reference: 'MBP-STAY', status: 'active' });
    const result = await bulkDeleteConsoleLots(['MBP-MISSING']);
    expect(result.deleted).toEqual([]);
    expect(result.missing).toEqual(['MBP-MISSING']);
    expect(await ProductModel.countDocuments({ reference: keep.reference })).toBe(1);
  });
});
