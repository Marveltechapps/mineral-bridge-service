import { Router } from 'express';
import { z } from 'zod';
import { tooMany } from '../../common/errors/app-error.js';
import { validate } from '../../common/middleware/validate.js';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { channels, realtimeHub } from '../../realtime/auction-hub.js';
import type { HubEvent } from '../../realtime/auction-hub.js';
import { SSE_HEARTBEAT_MS } from '../../realtime/sse.js';
import { getUserContext, requireUser } from '../auth/auth.middleware.js';
import { notificationsService } from './notifications.service.js';

const streams = new Map<string, number>();
const frame = (e: HubEvent) =>
  `id: ${e.seq}\nevent: ${e.event}\ndata: ${JSON.stringify({ ...e.data, at: e.at })}\n\n`;

export function createV2NotificationsRouter(): Router {
  const r = Router();

  r.get(
    '/',
    requireUser,
    validate({
      query: z.object({
        unread: z.enum(['true', 'false']).optional(),
        cursor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const { user } = getUserContext(req);
      const q = req.query as { unread?: string; cursor?: string; limit?: number };
      const skip = q.cursor ? Number.parseInt(q.cursor, 10) || 0 : 0;
      const limit = q.limit ?? 30;
      const { rows, total, unreadCount } = await notificationsService.listCursor(user.id, {
        skip,
        limit,
        unread: q.unread === 'true',
      });
      res.json({
        items: rows.map((n) => ({
          id: n._id,
          event: n.event,
          title: n.title,
          body: n.body,
          target: n.target ?? null,
          readAt: n.readAt?.toISOString?.() ?? null,
          createdAt: n.createdAt.toISOString(),
        })),
        nextCursor: skip + rows.length < total ? String(skip + rows.length) : null,
        unreadCount,
      });
    }),
  );

  r.post(
    '/:id/read',
    requireUser,
    asyncHandler(async (req, res) => {
      const unreadCount = await notificationsService.markRead(getUserContext(req).user.id, String(req.params.id));
      res.json({ unreadCount });
    }),
  );

  r.post(
    '/read-all',
    requireUser,
    asyncHandler(async (req, res) => {
      const out = await notificationsService.markAllRead(getUserContext(req).user.id);
      res.json({ unreadCount: out.unreadCount });
    }),
  );

  r.get(
    '/stream',
    requireUser,
    asyncHandler(async (req, res) => {
      const userId = getUserContext(req).user.id;
      if ((streams.get(userId) ?? 0) >= 5) {
        throw tooMany('realtime/too-many-streams', 'Too many open event streams.', 5);
      }
      streams.set(userId, (streams.get(userId) ?? 0) + 1);
      res.status(200).set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      res.write('retry: 3000\n\n');
      const channel = channels.user(userId);
      const lastId = Number(req.header('last-event-id') ?? req.query.lastEventId ?? '0') || 0;
      if (lastId > 0) for (const e of realtimeHub.replaySince(channel, lastId)) res.write(frame(e));
      const unsubscribe = realtimeHub.subscribe(channel, (e) => {
        if (e.to && e.to !== userId) return;
        res.write(frame(e));
      });
      const timer = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);
      timer.unref();
      const close = () => {
        clearInterval(timer);
        unsubscribe();
        const n = (streams.get(userId) ?? 1) - 1;
        if (n <= 0) streams.delete(userId);
        else streams.set(userId, n);
      };
      req.on('close', close);
      res.on('error', close);
    }),
  );

  return r;
}

export function createV2DevicesRouter(): Router {
  const r = Router();
  r.use(requireUser);
  r.post(
    '/',
    validate({
      body: z.object({
        token: z.string().min(10),
        platform: z.enum(['ios', 'android', 'web']),
        deviceId: z.string().optional(),
        appVersion: z.string().optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      await notificationsService.registerDevice(getUserContext(req).user.id, req.body);
      res.status(201).json({ ok: true });
    }),
  );
  r.delete(
    '/:token',
    asyncHandler(async (req, res) => {
      await notificationsService.unregisterDevice(getUserContext(req).user.id, String(req.params.token));
      res.status(204).send();
    }),
  );
  return r;
}
