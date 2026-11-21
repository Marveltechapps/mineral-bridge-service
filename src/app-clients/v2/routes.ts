import { Router } from 'express';
import { createV2AuthRouter } from '../../modules/auth/v2.auth.routes.js';
import { createV2MeRouter } from '../../modules/auth/v2.me.routes.js';
import { createV2CartRouter } from '../../modules/cart/v2.cart.routes.js';
import { createV2CatalogueRouter } from '../../modules/catalog/v2.catalogue.routes.js';
import { createV2FilesRouter } from '../../modules/files/v2.files.routes.js';
import { createV2KycRouter } from '../../modules/kyc/v2.kyc.routes.js';
import {
  createV2DevicesRouter,
  createV2NotificationsRouter,
} from '../../modules/notifications/v2.notifications.routes.js';
import { createV2OrdersRouter } from '../../modules/orders/v2.orders.routes.js';
import { createV2ReferenceRouter } from '../../modules/reference/v2.reference.routes.js';
import { createV2SupportRouter } from '../../modules/support/v2.support.routes.js';
import { createV2AuctionsRouter } from '../../modules/auctions/v2.auctions.routes.js';
import { createV2RefundsRouter } from '../../modules/refunds/v2.refunds.routes.js';
import { createV2DocumentsRouter } from '../../modules/documents/v2.documents.routes.js';
import { requireCustomerV2Client, requireV2Client } from './client.middleware.js';

/** Customer Mobile + Web API surface (doc 07). */
export function createV2Router(): Router {
  const r = Router();
  r.use((req, res, next) => {
    // `/v2/admin` is a separate router. Leave it alone if a request falls through.
    if (req.path === '/admin' || req.path.startsWith('/admin/')) return next();
    requireV2Client(req, res, (err) => (err ? next(err) : requireCustomerV2Client(req, res, next)));
  });

  r.get('/health', (_req, res) => {
    res.json({ status: 'ok', api: 'v2' });
  });

  r.use('/auth', createV2AuthRouter());
  r.use('/me', createV2MeRouter());
  r.use('/kyc', createV2KycRouter());
  r.use('/files', createV2FilesRouter());
  r.use('/catalogue', createV2CatalogueRouter());
  r.use('/cart', createV2CartRouter());
  r.use('/orders', createV2OrdersRouter());
  r.use('/auctions', createV2AuctionsRouter());
  r.use('/refunds', createV2RefundsRouter());
  r.use('/documents', createV2DocumentsRouter());
  r.use('/notifications', createV2NotificationsRouter());
  r.use('/devices', createV2DevicesRouter());
  r.use('/support', createV2SupportRouter());
  r.use('/reference', createV2ReferenceRouter());

  r.get('/_meta', (_req, res) => {
    res.json({
      version: 2,
      modules: [
        'auth',
        'me',
        'kyc',
        'files',
        'catalogue',
        'cart',
        'orders',
        'auctions',
        'refunds',
        'documents',
        'notifications',
        'devices',
        'support',
        'reference',
      ],
      planned: [],
    });
  });

  return r;
}
