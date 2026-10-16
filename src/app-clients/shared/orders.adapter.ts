import { Router } from 'express';
import { ah } from '../../common/http/async-handler.js';
import { byClient } from '../../common/http/by-client.js';
import { idempotencyKey } from '../../common/middleware/idempotency-key.js';
import { validate } from '../../common/middleware/validate.js';
import { requireKyc, requireUser } from '../../modules/auth/auth.middleware.js';
import { ordersController as c } from '../../modules/orders/orders.controller.js';
import * as v from '../../modules/orders/orders.validation.js';

/**
 * Shared `/orders` paths (conflicts #7-#10). One route, two contracts:
 *  - mobile: product/cart requirement, cursor pages, flat order, inline `downloadUrl`
 *  - web: lot + paymentMethod, offset pages, `{order, settlement, counterparty}`, `FileRef`
 */
export function ordersSharedRouter(): Router {
  const r = Router();
  const orderId = validate({ params: v.orderIdParam });

  r.post(
    '/orders',
    requireUser,
    requireKyc,
    idempotencyKey(true),
    byClient({
      mobile: [validate({ body: v.mobileCreateOrderBody }), ah(c.createMobile)],
      web: [validate({ body: v.webCreateOrderBody }), ah(c.createWeb)],
    }),
  );

  r.get(
    '/orders',
    requireUser,
    byClient({
      mobile: [validate({ query: v.mobileListQuery }), ah(c.listMobile)],
      web: [validate({ query: v.webListQuery }), ah(c.listWeb)],
    }),
  );

  r.get('/orders/:orderId', requireUser, orderId, byClient({ mobile: ah(c.detailMobile), web: ah(c.detailWeb) }));

  r.get('/orders/:orderId/documents', requireUser, orderId, byClient({ mobile: ah(c.documentsMobile), web: ah(c.documentsWeb) }));

  return r;
}
