import { Router } from 'express';
import { filesRouter } from '../../modules/uploads/uploads.routes.js';
import { auctionsSharedRouter } from './auctions.adapter.js';
import { authSharedRouter } from './auth.adapter.js';
import { notificationsSharedRouter } from './notifications.adapter.js';
import { ordersSharedRouter } from './orders.adapter.js';
import { supportSharedRouter } from './support.adapter.js';

export type SharedRoutesOptions = {
  /**
   * Include the auth (OTP) adapter. It delegates to the auth module's own handlers, which pull in the
   * session/OTP stack; integration tests of the marketplace modules switch it off.
   */
  includeAuth?: boolean;
};

/** Paths that exist on both clients with different contracts; each handler dispatches on `req.apiClient`. */
export function sharedRoutes(opts: SharedRoutesOptions = {}): Router {
  const r = Router();
  if (opts.includeAuth !== false) r.use(authSharedRouter());
  r.use(ordersSharedRouter());
  r.use(auctionsSharedRouter());
  r.use(notificationsSharedRouter());
  r.use(supportSharedRouter());
  r.use(filesRouter());
  return r;
}
