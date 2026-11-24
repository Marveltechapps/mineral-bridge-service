import { Router } from 'express';
import { z } from 'zod';
import { notFound, unprocessable } from '../../common/errors/app-error.js';
import { validate } from '../../common/middleware/validate.js';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { fromGrams, mobileQuantity, toGrams } from '../../common/utils/quantity.js';
import { ProductModel } from '../../models/catalog.model.js';
import { getUserContext, requireUser } from '../auth/auth.middleware.js';
import { cartService as svc, type PricedCart } from './cart.service.js';

const qtySchema = z.object({
  value: z.union([z.string(), z.number()]).transform((v) => Number(v)),
  unit: z.enum(['g', 'kg', 't', 'ct', 'pc', 'bar']),
});

function toV2Cart(p: PricedCart) {
  return {
    items: p.lines.map((l) => {
      // BUG-012: never echo raw grams as an entered kg/t value — use mobileQuantity.
      const qty = mobileQuantity(l.grams);
      return {
        productRef: l.product?.reference ?? l.product?._id ?? null,
        name: l.product?.name ?? null,
        qty: { value: String(qty.value), unit: qty.unit, grams: qty.grams },
        entered: { value: String(qty.value), unit: qty.unit, grams: qty.grams },
        available: l.product
          ? { value: String(fromGrams(l.product.availableGrams, 'g')), unit: 'g' as const, grams: l.product.availableGrams }
          : null,
        ok: !l.issue,
        issue:
          l.issue === 'unavailable'
            ? 'withdrawn'
            : l.issue === 'insufficient-quantity'
              ? 'insufficient'
              : l.issue ?? null,
      };
    }),
    count: p.lines.length,
    version: p.cart.version,
  };
}

async function productIdFromRef(ref: string): Promise<string> {
  const p =
    (await ProductModel.findOne({ reference: ref }).lean()) ??
    (await ProductModel.findById(ref).lean());
  if (!p) throw notFound('catalogue/not-found', 'Product not found');
  return p._id;
}

export function createV2CartRouter(): Router {
  const r = Router();
  r.use(requireUser);

  r.get(
    '/',
    asyncHandler(async (req, res) => {
      const { user } = getUserContext(req);
      res.status(200).json(toV2Cart(await svc.price(user.id)));
    }),
  );

  r.put(
    '/items/:productRef',
    validate({
      params: z.object({ productRef: z.string().min(1) }),
      body: z.object({ qty: qtySchema, version: z.number().int().optional() }),
    }),
    asyncHandler(async (req, res) => {
      const { user } = getUserContext(req);
      const productId = await productIdFromRef(String(req.params.productRef));
      const qty = (req.body as { qty: { value: number; unit: string } }).qty;
      if (qty.unit === 'pc' || qty.unit === 'bar') {
        // Piece/bar: treat value as grams equivalent only when product unit matches — enforced loosely.
        if (qty.value <= 0) throw unprocessable('Invalid quantity', { qty: 'Must be > 0' });
      }
      let grams: number;
      if (qty.unit === 'pc' || qty.unit === 'bar') {
        grams = qty.value;
      } else if (qty.unit === 'ct') {
        grams = toGrams(qty.value, 'ct');
      } else {
        grams = toGrams(qty.value, qty.unit as 'g' | 'kg' | 't');
      }

      // Replace quantity for this product: remove existing line then add.
      const priced = await svc.price(user.id);
      const existing = priced.cart.items.find((i) => i.productId === productId);
      if (existing) {
        res.status(200).json(toV2Cart(await svc.patchItem(user.id, existing._id, grams)));
        return;
      }
      res.status(200).json(toV2Cart(await svc.addItem(user.id, productId, grams)));
    }),
  );

  r.delete(
    '/items/:productRef',
    validate({ params: z.object({ productRef: z.string().min(1) }) }),
    asyncHandler(async (req, res) => {
      const { user } = getUserContext(req);
      const productId = await productIdFromRef(String(req.params.productRef));
      const priced = await svc.price(user.id);
      const existing = priced.cart.items.find((i) => i.productId === productId);
      if (!existing) {
        res.status(200).json(toV2Cart(priced));
        return;
      }
      res.status(200).json(toV2Cart(await svc.removeItem(user.id, existing._id)));
    }),
  );

  return r;
}
