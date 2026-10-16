import { Router } from 'express';
import { currentUser, currentUserId } from '../common/http/actor.js';
import { ah } from '../common/http/async-handler.js';
import { tooMany } from '../common/errors/app-error.js';
import { requireUser } from '../modules/auth/auth.middleware.js';
import { channels, realtimeHub } from './auction-hub.js';
import type { HubEvent } from './auction-hub.js';
import { signWsTicket } from './ws-auth.js';

export const SSE_HEARTBEAT_MS = 20_000;
const MAX_STREAMS_PER_USER = 5;
const streams = new Map<string, number>();

const frame = (e: HubEvent) => `id: ${e.seq}\nevent: ${e.event}\ndata: ${JSON.stringify({ ...e.data, at: e.at })}\n\n`;

/**
 * - `POST /ws-tokens`: single-use WebSocket ticket for browsers (contract §24: no bearer in the URL).
 * - `GET /events/notifications`: SSE stream of the caller's user channel (`notification.created`,
 *   `order.stage_changed`, `lc.status_changed`, `kyc.decided`, `session.revoked`, ...). `Last-Event-ID`
 *   replays from the in-process ring buffer; a `: ping` comment is sent every 20 s.
 */
export function realtimeHttpRouter(): Router {
  const r = Router();

  r.post('/ws-tokens', requireUser, ah(async (req, res) => {
    const u = currentUser(req);
    const t = signWsTicket(currentUserId(req), u.client);
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ wsToken: t.token, expiresIn: t.expiresIn });
  }));

  r.get('/events/notifications', requireUser, ah(async (req, res) => {
    const userId = currentUserId(req);
    if ((streams.get(userId) ?? 0) >= MAX_STREAMS_PER_USER) throw tooMany('realtime/too-many-streams', 'Too many open event streams.', 5);
    streams.set(userId, (streams.get(userId) ?? 0) + 1);

    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
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

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      unsubscribe();
      const n = (streams.get(userId) ?? 1) - 1;
      if (n <= 0) streams.delete(userId); else streams.set(userId, n);
    };
    req.on('close', close);
    res.on('error', close);
  }));

  return r;
}
