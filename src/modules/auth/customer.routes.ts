import { Router } from 'express';
import { byClient } from '../../common/middleware/by-client.js';
import { createMobileAuthRouter } from './mobile.auth.routes.js';
import { createWebAuthRouter } from './web.auth.routes.js';

/**
 * Customer auth under `/v1`. Six METHOD+path pairs collide between mobile and web
 * (`POST /auth/otp/{request,verify,resend}`, `DELETE /auth/account`, `GET /auth/sessions`,
 * `DELETE /auth/sessions/{id}`) with different contracts; `byClient` dispatches the whole
 * router on `req.apiClient`. Paths that exist for only one client fall through to the
 * global 404 for the other.
 */
export function createCustomerAuthRouter(): Router {
  const r = Router();
  r.use(byClient({ mobile: createMobileAuthRouter(), web: createWebAuthRouter() }));
  return r;
}
