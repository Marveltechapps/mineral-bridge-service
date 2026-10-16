import type { Router } from 'express';
import { clientRouter } from '../../common/http/by-client.js';
import { mobileAccountRouter } from '../../modules/account/account.routes.js';
import { mobileAuctionsRouter } from '../../modules/auctions/auctions.routes.js';
import { mobileCartRouter } from '../../modules/cart/cart.routes.js';
import { mobileCatalogRouter } from '../../modules/catalog/catalog.routes.js';
import { mobileContentRouter } from '../../modules/content/content.routes.js';
import { mobileDocumentsRouter } from '../../modules/documents/documents.routes.js';
import { mobileLearnRouter } from '../../modules/learning/learning.routes.js';
import { mobileNotificationsRouter } from '../../modules/notifications/notifications.routes.js';
import { mobileOrdersRouter } from '../../modules/orders/orders.routes.js';
import { mobilePayoutsRouter } from '../../modules/payouts/payouts.routes.js';
import { mobileSellRouter } from '../../modules/sell/sell.routes.js';
import { mobileSupportRouter } from '../../modules/support/support.routes.js';

/** Every mobile-unique router. Only requests with `req.apiClient === 'mobile'` enter. */
export function mobileRoutes(): Router {
  const r = clientRouter('mobile');
  r.use(mobileCatalogRouter());
  r.use(mobileCartRouter());
  r.use(mobileOrdersRouter());
  r.use(mobileSellRouter());
  r.use(mobileAuctionsRouter());
  r.use(mobileLearnRouter());
  r.use(mobilePayoutsRouter());
  r.use(mobileDocumentsRouter());
  r.use(mobileNotificationsRouter());
  r.use(mobileSupportRouter());
  r.use(mobileContentRouter());
  r.use(mobileAccountRouter());
  return r;
}
