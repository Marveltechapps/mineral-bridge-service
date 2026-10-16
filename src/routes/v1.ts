import { Router } from 'express';
import { buildCustomerV1Router } from '../app-clients/v1.js';
import { createCustomerAuthRouter } from '../modules/auth/customer.routes.js';
import { createCustomerKycRouter } from '../modules/kyc/customer.routes.js';
import { referenceRouter } from '../modules/reference/reference.routes.js';
import { realtimeHttpRouter } from '../realtime/sse.js';

/**
 * Customer API mounted at /v1: mobile and web merged into one router.
 *
 * Paths that exist for both clients with different contracts are dispatched on `req.apiClient`
 * (auth and kyc use `byClient` inside their own routers; orders/auctions/notifications/support use the
 * adapters in `app-clients/shared`); everything client-specific sits behind `clientRouter(...)` in
 * `app-clients/mobile` and `app-clients/web`, so it is invisible to the other client.
 */
export function buildV1Router(): Router {
  const r = Router();

  r.use(createCustomerAuthRouter());
  r.use(createCustomerKycRouter());
  // The auth module already owns /auth/*, so the marketplace aggregator is mounted without its auth adapter.
  r.use(buildCustomerV1Router({ includeAuth: false }));
  r.use(realtimeHttpRouter()); // POST /ws-tokens, GET /events/notifications (SSE)
  r.use(referenceRouter); // shared public lookups (minerals, countries, units, categories, banks)
  return r;
}
