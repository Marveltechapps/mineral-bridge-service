import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDb, createUser, seedProduct, startDb, stopDb } from './helpers/harness.js';
import { auctionsService } from '../src/modules/auctions/auctions.service.js';
import { negotiationsService } from '../src/modules/negotiations/negotiations.service.js';
import { auctionHub } from '../src/realtime/auction-hub.js';
import { signWsTicket } from '../src/realtime/ws-auth.js';
import { attachWebSocketServer } from '../src/realtime/ws-server.js';

vi.mock('../src/modules/auth/auth.middleware.js', async () => await import('./helpers/fake-auth.js'));

let server: http.Server;
let port: number;
const ORIGIN = 'http://localhost:5173';

beforeAll(async () => {
  await startDb();
  server = http.createServer();
  attachWebSocketServer(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await stopDb();
});
beforeEach(async () => {
  await clearDb();
  auctionHub.reset();
});

const url = (path: string, token?: string) => `ws://127.0.0.1:${port}${path}${token ? `?token=${encodeURIComponent(token)}` : ''}`;

/** Resolves with the HTTP status when the upgrade is refused, or 101 when it succeeds. */
function connect(path: string, token: string | undefined, origin: string | undefined = ORIGIN): Promise<{ status: number; ws?: WebSocket }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url(path, token), { origin });
    ws.once('open', () => resolve({ status: 101, ws }));
    ws.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode ?? 0 }));
    ws.once('error', () => undefined);
  });
}

const nextFrame = (ws: WebSocket) => new Promise<Record<string, unknown>>((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()))));

async function liveAuction() {
  const t = Date.now();
  return auctionsService.create({ name: 'Gold dore 1kg', quantityGrams: 1000, startingBidMinor: 100_000, minimumIncrementMinor: 1_000, opensAt: new Date(t - 3_600_000), closesAt: new Date(t + 3_600_000) });
}

describe('websocket upgrade', () => {
  it('web: a ticket opens the auction channel once; frames use the web envelope with money as {amount,currency}', async () => {
    const a = await liveAuction();
    const user = await createUser();
    const t = signWsTicket(user, 'web').token;
    const { status, ws } = await connect(`/v1/ws/auctions/${a._id}`, t);
    expect(status).toBe(101);

    const frame = nextFrame(ws!);
    auctionHub.bidPlaced({ auctionId: a._id, bidId: 'bid_1', bidderId: 'someone', bidderLabel: 'Bidder 7', amountMinor: 120_000, currency: 'USD', placedAt: new Date().toISOString(), bidCount: 1, highestMinor: 120_000, minimumNextMinor: 121_000, reserveMet: false, version: 1, kind: 'manual' });
    const f = await frame;
    expect(f).toMatchObject({ event: 'bid.placed', sequence: 1, data: { bidCount: 1, amount: { amount: 120_000, currency: 'USD' } } });
    expect(f.data).not.toHaveProperty('amount.scale');
    ws!.close();

    expect((await connect(`/v1/ws/auctions/${a._id}`, t)).status).toBe(401); // single-use
  });

  it('mobile-only and web-only channels are invisible to the other client; foreign resources are 404', async () => {
    const user = await createUser();
    const other = await createUser();
    const seller = await createUser();
    const lot = await seedProduct({ sellerId: seller });
    const n = await negotiationsService.start(user, {
      lotId: lot._id,
      offer: { price: { amountMinor: 5_000_000, currency: 'USD' }, unit: 'kg', quantity: 1, incoterm: 'FOB', namedPort: 'Tema', shipmentFrom: '2026-12-01', shipmentTo: '2026-12-10' },
      idempotencyKey: 'ws-neg-key-1',
    });
    expect((await connect(`/v1/ws/negotiations/${n.id}`, signWsTicket(other, 'web').token)).status).toBe(404); // not a party
    expect((await connect(`/v1/ws/negotiations/${n.id}`, signWsTicket(user, 'mobile').token, undefined)).status).toBe(404); // mobile has no negotiation channel
    expect((await connect(`/v1/ws/sell-requests/sel_x`, signWsTicket(user, 'web').token)).status).toBe(404); // web has no sell channel

    const ok = await connect(`/v1/ws/negotiations/${n.id}`, signWsTicket(seller, 'web').token);
    expect(ok.status).toBe(101);
    const frame = nextFrame(ok.ws!);
    await negotiationsService.sendMessage(user, n.id, 'Can you do 5.1?');
    expect(await frame).toMatchObject({ event: 'message.created', data: { author: 'counterparty', body: 'Can you do 5.1?' } });
    ok.ws!.close();
  });

  it('rejects browsers from foreign origins and unauthenticated upgrades', async () => {
    const a = await liveAuction();
    const user = await createUser();
    expect((await connect(`/v1/ws/auctions/${a._id}`, signWsTicket(user, 'web').token, 'https://evil.example')).status).toBe(403);
    expect((await connect(`/v1/ws/auctions/${a._id}`, undefined)).status).toBe(401);
    expect((await connect(`/v1/ws/auctions/${a._id}`, 'not-a-ticket')).status).toBe(401);
  });

  it('targeted events (bidder.outbid) reach only the addressed user', async () => {
    const a = await liveAuction();
    const [u1, u2] = [await createUser(), await createUser()];
    const c1 = await connect(`/v1/ws/auctions/${a._id}`, signWsTicket(u1, 'web').token);
    const c2 = await connect(`/v1/ws/auctions/${a._id}`, signWsTicket(u2, 'web').token);
    const got2: unknown[] = [];
    c2.ws!.on('message', (d) => got2.push(JSON.parse(d.toString())));
    const f1 = nextFrame(c1.ws!);
    auctionHub.outbid({ auctionId: a._id, auctionName: 'Gold', outbidUserId: u1, newHighestMinor: 130_000, yourBidMinor: 120_000, currency: 'USD', closesAt: new Date().toISOString() });
    expect(await f1).toMatchObject({ event: 'bidder.outbid', data: { yourBid: { amount: 120_000 }, currentBid: { amount: 130_000 } } });
    await new Promise((r) => setTimeout(r, 100));
    expect(got2).toHaveLength(0);
    c1.ws!.close();
    c2.ws!.close();
  });
});
