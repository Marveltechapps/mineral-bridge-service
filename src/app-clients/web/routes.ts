import type { Router } from 'express';
import { clientRouter } from '../../common/http/by-client.js';
import { webAccountRouter } from '../../modules/account/account.routes.js';
import { webAsmRouter } from '../../modules/asm/asm.routes.js';
import { webAuctionsRouter } from '../../modules/auctions/auctions.routes.js';
import { webContractsRouter } from '../../modules/contracts/contracts.routes.js';
import { webMarketRouter, webReferenceRouter } from '../../modules/content/content.routes.js';
import { webDocumentsRouter } from '../../modules/documents/documents.routes.js';
import { webAcademyRouter } from '../../modules/learning/learning.routes.js';
import { webLcsRouter } from '../../modules/lcs/lcs.routes.js';
import { webListingsRouter } from '../../modules/listings/listings.routes.js';
import { webLotsRouter } from '../../modules/lots/lots.routes.js';
import { webNegotiationsRouter } from '../../modules/negotiations/negotiations.routes.js';
import { webNotificationsRouter } from '../../modules/notifications/notifications.routes.js';
import { webOrdersRouter } from '../../modules/orders/orders.routes.js';
import { webPassportsRouter } from '../../modules/passports/passports.routes.js';
import { webShipmentsRouter } from '../../modules/shipments/shipments.routes.js';
import { webSupportRouter } from '../../modules/support/support.routes.js';
import { webUploadsRouter } from '../../modules/uploads/uploads.routes.js';

/** Every web-unique router. Only requests with `req.apiClient === 'web'` enter. */
export function webRoutes(): Router {
  const r = clientRouter('web');
  r.use(webReferenceRouter());
  r.use(webMarketRouter());
  r.use(webLotsRouter());
  r.use(webPassportsRouter());
  r.use(webOrdersRouter());
  r.use(webListingsRouter());
  r.use(webAuctionsRouter());
  r.use(webAcademyRouter());
  r.use(webAsmRouter());
  r.use(webAccountRouter());
  r.use(webDocumentsRouter());
  r.use(webNegotiationsRouter());
  r.use(webContractsRouter());
  r.use(webLcsRouter());
  r.use(webShipmentsRouter());
  r.use(webNotificationsRouter());
  r.use(webSupportRouter());
  r.use(webUploadsRouter());
  return r;
}
