import { Router } from 'express';
import { ah } from '../../common/http/async-handler.js';
import { byClient } from '../../common/http/by-client.js';
import { validate } from '../../common/middleware/validate.js';
import { requireUser } from '../../modules/auth/auth.middleware.js';
import { notificationsController as c } from '../../modules/notifications/notifications.controller.js';
import * as v from '../../modules/notifications/notifications.validation.js';

/** Shared `/notifications` paths (conflicts #15-#16). */
export function notificationsSharedRouter(): Router {
  const r = Router();

  r.get(
    '/notifications',
    requireUser,
    byClient({
      mobile: [validate({ query: v.mobileListQuery }), ah(c.listMobile)],
      web: [validate({ query: v.webListQuery }), ah(c.listWeb)],
    }),
  );

  // Mobile: 200 { unreadCount }.  Web: 204.
  r.post(
    '/notifications/:notificationId/read',
    requireUser,
    validate({ params: v.idParam }),
    byClient({ mobile: ah(c.markReadMobile), web: ah(c.markReadWeb) }),
  );

  return r;
}
