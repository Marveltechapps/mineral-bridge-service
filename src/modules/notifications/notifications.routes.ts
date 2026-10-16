import { Router } from 'express';
import { ah } from '../../common/http/async-handler.js';
import { validate } from '../../common/middleware/validate.js';
import { requireUser } from '../auth/auth.middleware.js';
import { notificationsController as c } from './notifications.controller.js';
import * as v from './notifications.validation.js';

/** Mobile-only notification routes (list + `/:id/read` are shared; see app-clients/shared). */
export function mobileNotificationsRouter(): Router {
  const r = Router();
  r.post('/notifications/read', requireUser, ah(c.markAllReadMobile));
  r.post('/notifications/devices', requireUser, validate({ body: v.registerDeviceBody }), ah(c.registerDevice));
  r.delete('/notifications/devices/:token', requireUser, validate({ params: v.tokenParam }), ah(c.unregisterDevice));
  return r;
}

/** Web-only notification routes. */
export function webNotificationsRouter(): Router {
  const r = Router();
  r.post('/notifications/read-all', requireUser, ah(c.markAllReadWeb));
  r.patch('/notifications/preferences', requireUser, validate({ body: v.preferencesBody }), ah(c.preferencesWeb));
  return r;
}
