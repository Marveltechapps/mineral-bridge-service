import type { Request, Response } from 'express';
import { currentUserId } from '../../common/http/actor.js';
import { buildCursorPage, buildOffsetPage, cursorWindow, pageWindow } from '../../common/utils/cursor.js';
import { toMobileNotification, toWebNotification } from './notifications.dto.js';
import { notificationsService as svc } from './notifications.service.js';

export const notificationsController = {
  /* mobile */
  async listMobile(req: Request, res: Response) {
    const userId = currentUserId(req);
    const win = cursorWindow(req.query as { limit?: unknown; cursor?: unknown });
    const unread = Boolean(req.query.unread) && (req.query.unread as unknown) !== 'false';
    const { rows, total, unreadCount } = await svc.listCursor(userId, { ...win, unread });
    const page = buildCursorPage(rows.map(toMobileNotification), total, win);
    res.json({ ...page, meta: { ...page.meta, unreadCount } });
  },

  async markAllReadMobile(req: Request, res: Response) {
    await svc.markAllRead(currentUserId(req));
    res.json({ unreadCount: 0 });
  },

  async markReadMobile(req: Request, res: Response) {
    const unreadCount = await svc.markRead(currentUserId(req), String(req.params.notificationId));
    res.json({ unreadCount });
  },

  async registerDevice(req: Request, res: Response) {
    await svc.registerDevice(currentUserId(req), req.body);
    res.status(204).end();
  },

  async unregisterDevice(req: Request, res: Response) {
    await svc.unregisterDevice(currentUserId(req), String(req.params.token));
    res.status(204).end();
  },

  /* web */
  async listWeb(req: Request, res: Response) {
    const userId = currentUserId(req);
    const q = req.query as { page?: unknown; perPage?: unknown; unreadOnly?: unknown; kind?: string };
    const win = pageWindow(q);
    const { rows, total, unreadCount } = await svc.listPaged(userId, {
      skip: win.skip,
      perPage: win.perPage,
      unreadOnly: q.unreadOnly === true,
      webKind: q.kind,
    });
    res.json({ ...buildOffsetPage(rows.map(toWebNotification), total, win), unreadCount });
  },

  async markReadWeb(req: Request, res: Response) {
    await svc.markRead(currentUserId(req), String(req.params.notificationId));
    res.status(204).end();
  },

  async markAllReadWeb(req: Request, res: Response) {
    const out = await svc.markAllRead(currentUserId(req));
    res.json({ markedCount: out.markedCount });
  },

  async preferencesWeb(req: Request, res: Response) {
    const prefs = await svc.updatePreferences(currentUserId(req), req.body);
    res.json({ preferences: { channels: { email: prefs.email, sms: prefs.sms, push: prefs.push }, kinds: prefs.kinds } });
  },
};
