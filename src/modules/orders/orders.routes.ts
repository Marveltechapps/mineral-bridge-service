import { Router } from 'express';
import { ah } from '../../common/http/async-handler.js';
import { validate } from '../../common/middleware/validate.js';
import { optionalUser, requireKyc, requireUser } from '../auth/auth.middleware.js';
import { ordersController as c } from './orders.controller.js';
import * as v from './orders.validation.js';

/** Mobile-only order routes. Shared list/create/detail/documents live in app-clients/shared. */
export function mobileOrdersRouter(): Router {
  const r = Router();
  r.post('/orders/requirements/price', requireUser, requireKyc, validate({ body: v.mobilePriceBody }), ah(c.priceRequirement));
  r.get('/orders/:orderId/tracking', requireUser, validate({ params: v.orderIdParam }), ah(c.tracking));
  r.post(
    '/orders/:orderId/confirm-delivery',
    requireUser,
    requireKyc,
    validate({ params: v.orderIdParam, body: v.confirmDeliveryBody }),
    ah(c.confirmDelivery),
  );
  return r;
}

/** Web-only order routes. */
export function webOrdersRouter(): Router {
  const r = Router();
  r.post('/orders/quote', optionalUser, validate({ body: v.webQuoteBody }), ah(c.quote));
  r.get('/orders/:orderId/timeline', requireUser, validate({ params: v.orderIdParam }), ah(c.timeline));
  r.get('/orders/:orderId/logistics', requireUser, validate({ params: v.orderIdParam }), ah(c.logistics));
  r.get('/orders/:orderId/documents/:documentId/download', requireUser, validate({ params: v.orderDocParams }), ah(c.download));
  r.post('/orders/:orderId/cancel', requireUser, validate({ params: v.orderIdParam, body: v.cancelBody }), ah(c.cancel));
  return r;
}
