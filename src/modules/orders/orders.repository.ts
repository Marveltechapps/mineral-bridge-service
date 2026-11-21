import type { FilterQuery, UpdateQuery } from 'mongoose';
import { CartModel, QuoteModel } from '../../models/cart.model.js';
import type { ICart, IQuote } from '../../models/cart.model.js';
import { ProductModel } from '../../models/catalog.model.js';
import type { IProduct } from '../../models/catalog.model.js';
import { OrderModel } from '../../models/order.model.js';
import type { IOrder } from '../../models/order.model.js';
import { BulkQuoteModel, SellRequestModel } from '../../models/sell.model.js';
import { UserModel } from '../../models/user.model.js';
import type { IUser } from '../../models/user.model.js';

function isDup(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

export const ordersRepository = {
  isDuplicateKey: isDup,

  findById: (id: string) => OrderModel.findById(id).lean<IOrder>(),

  findBySettlementKey: (key: string) => OrderModel.findOne({ settlementKey: key }).lean<IOrder>(),

  async insert(doc: Omit<IOrder, '_id' | 'createdAt' | 'updatedAt'> & { _id?: string }): Promise<IOrder> {
    const created = await OrderModel.create(doc);
    return created.toObject() as IOrder;
  },

  /** Compare-and-set on `version`; returns null when the order moved underneath the caller. */
  casUpdate(id: string, version: number, update: UpdateQuery<IOrder>, extraFilter: FilterQuery<IOrder> = {}) {
    const inc = { ...(update.$inc ?? {}), version: 1 };
    return OrderModel.findOneAndUpdate({ _id: id, version, ...extraFilter }, { ...update, $inc: inc }, { new: true }).lean<IOrder>();
  },

  async list(filter: FilterQuery<IOrder>, skip: number, limit: number) {
    const [rows, total] = await Promise.all([
      OrderModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean<IOrder[]>(),
      OrderModel.countDocuments(filter),
    ]);
    return { rows, total };
  },

  count: (filter: FilterQuery<IOrder>) => OrderModel.countDocuments(filter),

  async countSelling(userId: string): Promise<number> {
    const [a, b] = await Promise.all([
      SellRequestModel.countDocuments({ userId, status: { $in: ['booked', 'evaluating', 'offer_ready'] } }),
      BulkQuoteModel.countDocuments({ userId, status: { $in: ['desk_pricing', 'document_check', 'assay', 'offer_issued'] } }),
    ]);
    return a + b;
  },

  findProduct: (id: string) => ProductModel.findById(id).lean<IProduct>(),

  /** Atomically reserve stock; false if not enough remains. Marks the product `sold` at zero. */
  async reserveStock(productId: string, grams: number): Promise<boolean> {
    // One atomic write: decrement and flip to `sold` at zero. A separate second write left a window where a
    // depleted lot read as "active with 0 g" (the no-availability-figure case) and a concurrent order skipped reservation.
    const res = await ProductModel.updateOne(
      { _id: productId, status: 'active', availableGrams: { $gte: grams } },
      [
        { $set: { availableGrams: { $subtract: ['$availableGrams', grams] } } },
        { $set: { status: { $cond: [{ $lte: ['$availableGrams', 0] }, 'sold', '$status'] } } },
      ],
    );
    return res.modifiedCount === 1;
  },

  async restoreStock(productId: string, grams: number): Promise<void> {
    await ProductModel.updateOne({ _id: productId }, [
      { $set: { availableGrams: { $add: ['$availableGrams', grams] } } },
      { $set: { status: { $cond: [{ $and: [{ $eq: ['$status', 'sold'] }, { $gt: ['$availableGrams', 0] }] }, 'active', '$status'] } } },
    ]);
  },

  findCart: (userId: string) => CartModel.findOne({ userId }).lean<ICart>(),
  clearCart: (userId: string) => CartModel.updateOne({ userId }, { $set: { items: [] }, $inc: { version: 1 } }),

  saveQuote: async (q: Omit<IQuote, '_id' | 'createdAt'>) => (await QuoteModel.create(q)).toObject() as IQuote,
  findQuote: (id: string) => QuoteModel.findById(id).lean<IQuote>(),

  findUser: (id: string) => UserModel.findById(id).lean<IUser>(),
};
