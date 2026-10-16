import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { loadEnv } from '../config/env.js';
import { logger } from '../config/logger.js';
import { verifyAccessToken } from '../modules/auth/auth.tokens.js';
import { findActiveCustomerSession } from '../modules/sessions/session.service.js';
import { negotiationsService } from '../modules/negotiations/negotiations.service.js';
import { supportService } from '../modules/support/support.service.js';
import { channels, realtimeHub } from './auction-hub.js';
import type { HubEvent } from './auction-hub.js';
import { authorizeChannel, CHANNEL_CLIENTS, consumeWsTicket } from './ws-auth.js';
import type { WsChannelKind, WsClient } from './ws-auth.js';
import { mapEvent } from './ws-frames.js';

const HEARTBEAT_MS = 20_000;
const MAX_SOCKETS_PER_USER = 10;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_MESSAGES = 20;
export const WS_SUBPROTOCOL = 'mineralbridge.v1';

const ROUTES: { re: RegExp; kind: WsChannelKind }[] = [
  { re: /^\/(?:v1\/)?ws\/auctions\/([A-Za-z0-9_.:-]{1,80})$/, kind: 'auction' },
  { re: /^\/(?:v1\/)?ws\/sell-requests\/([A-Za-z0-9_.:-]{1,80})$/, kind: 'sell-request' },
  { re: /^\/(?:v1\/)?ws\/support\/chat\/([A-Za-z0-9_.:-]{1,80})$/, kind: 'chat' },
  { re: /^\/(?:v1\/)?ws\/negotiations\/([A-Za-z0-9_.:-]{1,80})$/, kind: 'negotiation' },
];

const channelFor = (kind: WsChannelKind, id: string) =>
  ({ auction: channels.auction, 'sell-request': channels.sellRequest, chat: channels.chat, negotiation: channels.negotiation })[kind](id);

function reject(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

type Identity = { userId: string; client: WsClient };

/**
 * Mobile: `Sec-WebSocket-Protocol: mineralbridge.v1, bearer.<accessToken>` (or an Authorization header).
 * Web: `?token=<ws ticket>`; single-use, 60 s, valid for socket upgrades only (the bearer is never in a URL).
 */
async function authenticate(req: IncomingMessage, url: URL): Promise<Identity | null> {
  const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim());
  const bearer = offered.find((p) => p.startsWith('bearer.'))?.slice('bearer.'.length) ?? /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
  if (bearer) {
    const v = verifyAccessToken(bearer);
    if (!v.ok) return null;
    const session = await findActiveCustomerSession(v.claims.sid);
    if (!session || session.userId.toString() !== v.claims.sub || session.client !== v.claims.cli) return null;
    return { userId: v.claims.sub, client: v.claims.cli };
  }
  const ticket = url.searchParams.get('token');
  if (ticket) {
    const t = consumeWsTicket(ticket);
    return t.ok ? { userId: t.userId, client: t.client } : null;
  }
  return null;
}

/** Browsers always send Origin on WebSocket; refuse foreign origins (cross-site WebSocket hijacking). */
function originAllowed(req: IncomingMessage, client: WsClient): boolean {
  const origin = req.headers.origin;
  if (!origin) return client === 'mobile'; // native apps send none; a browser always does
  return loadEnv().corsWebOrigins.includes(origin);
}

const open = new Map<string, number>();

/**
 * Customer realtime: `/v1/ws/{auctions|sell-requests|support/chat|negotiations}/{id}`.
 * Domain events from the hub are mapped per client by `ws-frames`. `?since=<seq>` replays buffered events;
 * targeted events (`bidder.outbid`) reach only the addressed user. The admin live feed is SSE, not WebSocket.
 */
export function attachWebSocketServer(server: Server): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4096,
    handleProtocols: (protocols) => (protocols.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false),
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const route = ROUTES.map((r) => ({ kind: r.kind, m: r.re.exec(url.pathname) })).find((r) => r.m);
        if (!route?.m) return reject(socket, 404, 'Not Found');
        const id = route.m[1]!;
        const who = await authenticate(req, url);
        if (!who) return reject(socket, 401, 'Unauthorized');
        if (!CHANNEL_CLIENTS[route.kind].includes(who.client)) return reject(socket, 404, 'Not Found');
        if (!originAllowed(req, who.client)) return reject(socket, 403, 'Forbidden');
        if (!(await authorizeChannel(route.kind, id, who.userId))) return reject(socket, 404, 'Not Found');
        if ((open.get(who.userId) ?? 0) >= MAX_SOCKETS_PER_USER) return reject(socket, 429, 'Too Many Connections');
        const since = Number(url.searchParams.get('since') ?? '0') || 0;
        wss.handleUpgrade(req, socket, head, (ws) => subscribe(ws, route.kind, id, who, since));
      } catch (err) {
        logger.warn({ err }, 'websocket upgrade failed');
        reject(socket, 400, 'Bad Request');
      }
    })();
  });

  return wss;
}

function subscribe(ws: WebSocket, kind: WsChannelKind, resourceId: string, who: Identity, since: number): void {
  const channel = channelFor(kind, resourceId);
  open.set(who.userId, (open.get(who.userId) ?? 0) + 1);

  const deliver = (e: HubEvent) => {
    if (e.to && e.to !== who.userId) return;
    if (ws.readyState !== ws.OPEN) return;
    for (const frame of mapEvent(kind, who.client, who.userId, e)) ws.send(JSON.stringify(frame));
  };
  if (since > 0) realtimeHub.replaySince(channel, since).forEach(deliver);
  const unsubscribe = realtimeHub.subscribe(channel, deliver);

  let alive = true;
  ws.on('pong', () => { alive = true; });
  const timer = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, HEARTBEAT_MS);
  timer.unref();

  const sendError = (code: string, message: string) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ event: 'error', data: { code, message } }));
  let windowStart = Date.now();
  let count = 0;

  ws.on('message', (raw) => {
    const nowMs = Date.now();
    if (nowMs - windowStart > RATE_WINDOW_MS) { windowStart = nowMs; count = 0; }
    if (++count > RATE_MAX_MESSAGES) return ws.close(1008, 'rate limit');
    let msg: { event?: unknown; data?: Record<string, unknown> };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return void sendError('request/malformed', 'Frames must be JSON');
    }
    void handleClientFrame(kind, resourceId, who, msg, ws).catch((err: { code?: string; message?: string }) => sendError(err.code ?? 'internal', err.message ?? 'Failed'));
  });

  const cleanup = () => {
    clearInterval(timer);
    unsubscribe();
    const n = (open.get(who.userId) ?? 1) - 1;
    if (n <= 0) open.delete(who.userId); else open.set(who.userId, n);
  };
  ws.once('close', cleanup);
  ws.on('error', () => ws.terminate());
}

/** Client-to-server frames: `ping`, `typing`, and `message.send` (chat + negotiations). */
async function handleClientFrame(kind: WsChannelKind, id: string, who: Identity, msg: { event?: unknown; data?: Record<string, unknown> }, ws: WebSocket): Promise<void> {
  if (msg.event === 'ping') return void ws.send(JSON.stringify({ event: 'pong', at: new Date().toISOString() }));
  const data = msg.data ?? {};
  if (msg.event === 'typing') {
    if (kind === 'chat') realtimeHub.publish(channels.chat(id), 'user.typing', { sessionId: id, isTyping: Boolean(data.isTyping), from: who.userId });
    if (kind === 'negotiation') realtimeHub.publish(channels.negotiation(id), 'typing', { negotiationId: id, from: who.userId });
    return;
  }
  if (msg.event === 'message.send') {
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    if (!text || text.length > 4000) throw Object.assign(new Error('Message must be 1-4000 characters'), { code: 'validation/failed' });
    if (kind === 'chat') {
      const clientId = typeof data.clientId === 'string' ? data.clientId.slice(0, 64) : undefined;
      await supportService.sendChat(who.userId, id, { body: text, clientId }); // publishes message.created itself
      return;
    }
    if (kind === 'negotiation') {
      await negotiationsService.sendMessage(who.userId, id, text);
      return;
    }
  }
  throw Object.assign(new Error('Unsupported frame for this channel'), { code: 'request/unsupported' });
}
