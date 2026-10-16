import { Router } from 'express';
import { currentUserId } from '../../common/http/actor.js';
import { ah } from '../../common/http/async-handler.js';
import { validate } from '../../common/middleware/validate.js';
import { mobileMoney } from '../../common/utils/currency.js';
import { toGrams } from '../../common/utils/quantity.js';
import { mobileQuantity } from '../../common/utils/quantity.js';
import { iso } from '../../common/utils/time-display.js';
import { requireUser } from '../auth/auth.middleware.js';
import { toMobileProduct } from '../catalog/product.mapper.js';
import { cartService as svc } from './cart.service.js';
import type { PricedCart } from './cart.service.js';
import * as v from './cart.validation.js';

function toMobileCart(p: PricedCart) {
  const m = (amountMinor: number) => mobileMoney({ amountMinor, currency: p.currency });
  return {
    id: p.cart._id,
    version: p.cart.version,
    items: p.lines.map((l) => ({
      id: l.itemId,
      product: l.product ? toMobileProduct(l.product) : null,
      quantity: mobileQuantity(l.grams),
      lineTotal: m(l.lineTotalMinor),
      ...(l.issue ? { issue: l.issue } : {}),
    })),
    totals: { subtotal: m(p.subtotalMinor), handling: m(p.handlingMinor), total: m(p.totalMinor) },
  };
}

/** Mobile-only: /cart. */
export function mobileCartRouter(): Router {
  const r = Router();
  r.get('/cart', requireUser, ah(async (req, res) => res.json(toMobileCart(await svc.price(currentUserId(req))))));

  r.post('/cart/items', requireUser, validate({ body: v.addItemBody }), ah(async (req, res) => {
    const b = req.body as { productId: string; quantity: { value: number; unit: 'g' | 'kg' | 't' } };
    res.status(201).json(toMobileCart(await svc.addItem(currentUserId(req), b.productId, toGrams(b.quantity.value, b.quantity.unit))));
  }));

  r.patch('/cart/items/:itemId', requireUser, validate({ params: v.itemIdParam, body: v.patchItemBody }), ah(async (req, res) => {
    const b = req.body as { quantity: { value: number; unit: 'g' | 'kg' | 't' } };
    res.json(toMobileCart(await svc.patchItem(currentUserId(req), String(req.params.itemId), toGrams(b.quantity.value, b.quantity.unit))));
  }));

  r.delete('/cart/items/:itemId', requireUser, validate({ params: v.itemIdParam }), ah(async (req, res) => {
    res.json(toMobileCart(await svc.removeItem(currentUserId(req), String(req.params.itemId))));
  }));

  r.post('/cart/quote', requireUser, ah(async (req, res) => {
    const out = await svc.quote(currentUserId(req));
    res.json({ quoteId: out.quoteId, expiresAt: iso(out.expiresAt), cart: toMobileCart(out.priced) });
  }));

  return r;
}
