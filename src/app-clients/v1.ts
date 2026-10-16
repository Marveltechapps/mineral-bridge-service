import { Router } from 'express';
import type { Express } from 'express';
import { mobileRoutes } from './mobile/routes.js';
import { sharedRoutes } from './shared/routes.js';
import type { SharedRoutesOptions } from './shared/routes.js';
import { webRoutes } from './web/routes.js';

/**
 * Customer marketplace API. Mount at /v1 (after request-context middleware, before the not-found handler):
 *   app.use('/v1', buildCustomerV1Router());
 * Realtime (WebSocket upgrade + SSE) is attached separately with `attachRealtime(server, app)`.
 */
export function buildCustomerV1Router(opts: SharedRoutesOptions = {}): Router {
  const r = Router();
  r.use(sharedRoutes(opts));
  r.use(mobileRoutes());
  r.use(webRoutes());
  return r;
}

export function mountCustomerApi(app: Express, opts: SharedRoutesOptions = {}): void {
  app.use('/v1', buildCustomerV1Router(opts));
}
