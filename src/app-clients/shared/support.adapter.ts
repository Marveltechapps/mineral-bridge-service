import { Router } from 'express';
import { ah } from '../../common/http/async-handler.js';
import { byClient } from '../../common/http/by-client.js';
import { idempotencyKey } from '../../common/middleware/idempotency-key.js';
import { validate } from '../../common/middleware/validate.js';
import { requireUser } from '../../modules/auth/auth.middleware.js';
import * as s from '../../modules/support/support.routes.js';

/** Shared /support/tickets (list + create): cursor/flat vs page/envelope shapes (conflict #17). */
export function supportSharedRouter(): Router {
  const r = Router();
  r.get(
    '/support/tickets',
    requireUser,
    byClient({
      mobile: [validate({ query: s.mobileTicketsQuery }), ah(s.supportController.listMobile)],
      web: [validate({ query: s.webTicketsQuery }), ah(s.supportController.listWeb)],
    }),
  );
  r.post(
    '/support/tickets',
    requireUser,
    idempotencyKey(false),
    validate({ body: s.createTicketBody }),
    byClient({ mobile: ah(s.supportController.createMobile), web: ah(s.supportController.createWeb) }),
  );
  return r;
}
