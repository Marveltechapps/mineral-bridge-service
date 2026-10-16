import { createHmac, randomBytes } from 'node:crypto';
import { loadEnv } from '../config/env.js';
import { safeEqual } from '../common/utils/crypto.js';
import { ChatSessionModel } from '../models/support.model.js';
import { SellRequestModel } from '../models/sell.model.js';
import { NegotiationModel } from '../models/web-trade.model.js';
import { AuctionModel } from '../models/auction.model.js';

export type WsClient = 'mobile' | 'web';
export type WsChannelKind = 'auction' | 'sell-request' | 'chat' | 'negotiation';

export const WS_TICKET_TTL_SECONDS = 60;

/** Which clients may open which channel (mobile contract §8, web contract §24). */
export const CHANNEL_CLIENTS: Record<WsChannelKind, readonly WsClient[]> = {
  auction: ['mobile', 'web'],
  'sell-request': ['mobile'],
  chat: ['mobile'],
  negotiation: ['web'],
};

const sign = (payload: string) => createHmac('sha256', loadEnv().WS_TOKEN_SECRET).update(`ws:${payload}`).digest('base64url');

/** Spent ticket ids -> expiry (ms). Single-process; use a shared store (Redis SET NX EX) when scaling out. */
const spent = new Map<string, number>();
function pruneSpent(nowMs: number) {
  if (spent.size < 1000) return;
  for (const [k, exp] of spent) if (exp < nowMs) spent.delete(k);
}

/**
 * Short-lived, single-purpose, single-use ticket for browsers (which cannot set WebSocket headers).
 * It authenticates the *socket upgrade only*; it is useless against the REST API.
 */
export function signWsTicket(userId: string, client: WsClient, nowMs = Date.now()): { token: string; expiresIn: number } {
  const body = Buffer.from(JSON.stringify({ sub: userId, cli: client, jti: randomBytes(12).toString('base64url'), exp: Math.floor(nowMs / 1000) + WS_TICKET_TTL_SECONDS })).toString('base64url');
  return { token: `${body}.${sign(body)}`, expiresIn: WS_TICKET_TTL_SECONDS };
}

export type WsTicketResult = { ok: true; userId: string; client: WsClient } | { ok: false };

/** Verifies signature + expiry and burns the ticket: a second presentation fails. */
export function consumeWsTicket(token: string, nowMs = Date.now()): WsTicketResult {
  const [body, sig] = token.split('.');
  if (!body || !sig || !safeEqual(sign(body), sig)) return { ok: false };
  let claims: { sub?: string; cli?: string; jti?: string; exp?: number };
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false };
  }
  if (!claims.sub || !claims.jti || !claims.exp || (claims.cli !== 'mobile' && claims.cli !== 'web')) return { ok: false };
  if (claims.exp * 1000 < nowMs) return { ok: false };
  if (spent.has(claims.jti)) return { ok: false };
  pruneSpent(nowMs);
  spent.set(claims.jti, claims.exp * 1000);
  return { ok: true, userId: claims.sub, client: claims.cli };
}

export const resetWsTicketsForTests = () => spent.clear();

/** Does `userId` have the right to listen on this resource? Unknown resources and foreign ones look the same. */
export async function authorizeChannel(kind: WsChannelKind, resourceId: string, userId: string): Promise<boolean> {
  switch (kind) {
    case 'auction':
      return Boolean(await AuctionModel.exists({ _id: resourceId }));
    case 'sell-request':
      return Boolean(await SellRequestModel.exists({ _id: resourceId, userId }));
    case 'chat':
      return Boolean(await ChatSessionModel.exists({ _id: resourceId, userId }));
    case 'negotiation':
      return Boolean(await NegotiationModel.exists({ _id: resourceId, $or: [{ buyerId: userId }, { sellerId: userId }] }));
  }
}
