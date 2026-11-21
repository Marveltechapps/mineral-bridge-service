import { notFound, unprocessable } from '../../common/errors/app-error.js';
import { now } from '../../common/utils/clock.js';
import { opaqueId } from '../../common/utils/ids.js';
import { feeMinor, FEES, totalMinor } from '../../common/utils/pricing-math.js';
import { CartModel, QuoteModel } from '../../models/cart.model.js';
import type { ICart } from '../../models/cart.model.js';
import { ProductModel } from '../../models/catalog.model.js';
import type { IProduct } from '../../models/catalog.model.js';

export type PricedCart = {
  cart: ICart;
  lines: { itemId: string; product: IProduct | null; grams: number; lineTotalMinor: number; issue?: string }[];
  currency: string;
  subtotalMinor: number;
  handlingMinor: number;
  totalMinor: number;
};

async function ensureCart(userId: string): Promise<ICart> {
  const cart = await CartModel.findOneAndUpdate(
    { userId },
    { $setOnInsert: { userId, items: [], version: 0 } },
    { upsert: true, new: true },
  ).lean<ICart>();
  return cart!;
}

export function assertQuantity(p: IProduct, grams: number): void {
  if (p.status !== 'active') throw unprocessable('Product is not available', { productId: 'Unavailable' }, 'catalog/product-unavailable');
  if (!(grams > 0)) {
    throw unprocessable('Enter a quantity greater than zero', { quantity: 'Enter a quantity greater than zero' }, 'catalog/invalid-quantity');
  }
  if (grams > p.availableGrams) throw unprocessable('Only part of that quantity is available', { quantity: `Max ${p.availableGrams} g` }, 'catalog/insufficient-quantity');
}

export const cartService = {
  async price(userId: string): Promise<PricedCart> {
    const cart = await ensureCart(userId);
    const products = await ProductModel.find({ _id: { $in: cart.items.map((i) => i.productId) } }).lean<IProduct[]>();
    const byId = new Map(products.map((p) => [p._id, p]));
    let subtotal = 0;
    let currency = 'USD';
    const lines = cart.items.map((i) => {
      const p = byId.get(i.productId) ?? null;
      if (!p) return { itemId: i._id, product: null, grams: i.grams, lineTotalMinor: 0, issue: 'unavailable' };
      currency = p.currency;
      const lineTotalMinor = totalMinor(i.grams, p.unitPriceMinorE4PerGram);
      subtotal += lineTotalMinor;
      const issue = p.status !== 'active' ? 'unavailable' : i.grams > p.availableGrams ? 'insufficient-quantity' : undefined;
      return { itemId: i._id, product: p, grams: i.grams, lineTotalMinor, ...(issue ? { issue } : {}) };
    });
    const handlingMinor = feeMinor(subtotal, FEES.mobileCartHandlingBps);
    return { cart, lines, currency, subtotalMinor: subtotal, handlingMinor, totalMinor: subtotal + handlingMinor };
  },

  async addItem(userId: string, productId: string, grams: number) {
    const p = await ProductModel.findById(productId).lean<IProduct>();
    if (!p) throw notFound('catalog/product-not-found', 'Product not found');
    assertQuantity(p, grams);
    await ensureCart(userId);
    // Merge into an existing line for the same product, otherwise push.
    const merged = await CartModel.updateOne({ userId, 'items.productId': productId }, { $inc: { 'items.$.grams': grams, version: 1 } });
    if (merged.matchedCount === 0) {
      await CartModel.updateOne({ userId }, { $push: { items: { _id: opaqueId('cit'), productId, grams, addedAt: now() } }, $inc: { version: 1 } });
    }
    return this.price(userId);
  },

  async patchItem(userId: string, itemId: string, grams: number) {
    const cart = await ensureCart(userId);
    const item = cart.items.find((i) => i._id === itemId);
    if (!item) throw notFound('cart/item-not-found', 'Cart item not found');
    const p = await ProductModel.findById(item.productId).lean<IProduct>();
    if (!p) throw notFound('catalog/product-not-found', 'Product not found');
    assertQuantity(p, grams);
    await CartModel.updateOne({ userId, 'items._id': itemId }, { $set: { 'items.$.grams': grams }, $inc: { version: 1 } });
    return this.price(userId);
  },

  async removeItem(userId: string, itemId: string) {
    const res = await CartModel.updateOne({ userId, 'items._id': itemId }, { $pull: { items: { _id: itemId } }, $inc: { version: 1 } });
    if (res.matchedCount === 0) throw notFound('cart/item-not-found', 'Cart item not found');
    return this.price(userId);
  },

  /** Persisted quote so the totals the user saw can be referenced when ordering. */
  async quote(userId: string) {
    const priced = await this.price(userId);
    if (priced.lines.length === 0) throw unprocessable('Your cart is empty', { cart: 'Empty' }, 'cart/empty');
    const q = await QuoteModel.create({
      userId,
      lotId: priced.cart._id,
      grams: priced.lines.reduce((s, l) => s + l.grams, 0),
      paymentMethod: 'escrow',
      unitPriceMinorE4PerGram: 0,
      subtotal: { amountMinor: priced.subtotalMinor, currency: priced.currency },
      platformFee: { amountMinor: priced.handlingMinor, currency: priced.currency },
      surcharge: { amountMinor: 0, currency: priced.currency },
      total: { amountMinor: priced.totalMinor, currency: priced.currency },
      expiresAt: new Date(now().getTime() + 5 * 60_000),
    });
    return { priced, quoteId: q._id, expiresAt: q.expiresAt };
  },
};
