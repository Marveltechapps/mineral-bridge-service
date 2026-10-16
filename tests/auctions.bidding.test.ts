import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, clearDb, createUser, MOBILE, startDb, stopDb, WEB } from './helpers/harness.js';
import { setClock } from '../src/common/utils/clock.js';
import { AuctionModel, BidModel } from '../src/models/index.js';
import { auctionsService } from '../src/modules/auctions/auctions.service.js';

vi.mock('../src/modules/auth/auth.middleware.js', async () => await import('./helpers/fake-auth.js'));

const app = buildApp();
const HOUR = 3_600_000;

beforeAll(startDb);
afterAll(stopDb);
beforeEach(clearDb);

async function liveAuction(over: Record<string, unknown> = {}) {
  const t = Date.now();
  return auctionsService.create({
    name: 'Gold dore 1kg',
    quantityGrams: 1000,
    startingBidMinor: 100_000,
    minimumIncrementMinor: 1_000,
    opensAt: new Date(t - HOUR),
    closesAt: new Date(t + HOUR),
    ...over,
  });
}

describe('auction bidding concurrency', () => {
  it('mobile: N concurrent bids on the same version accept exactly one', async () => {
    const a = await liveAuction();
    const users = await Promise.all(Array.from({ length: 10 }, () => createUser()));
    const res = await Promise.all(
      users.map((u, i) =>
        request(app)
          .post(`/v1/auctions/${a._id}/bids`)
          .set(MOBILE)
          .set('x-test-user', u)
          .set('Idempotency-Key', `bid-mobile-${i}-aaaa`)
          .send({ amount: { amount: 100_000 + i * 1_000, currency: 'USD', scale: 2 }, version: 0, acceptBinding: true }),
      ),
    );
    const ok = res.filter((r) => r.status === 201);
    const rejected = res.filter((r) => r.status !== 201);
    expect(ok).toHaveLength(1);
    expect(rejected.every((r) => r.status === 409 || r.status === 422)).toBe(true);
    const after = await AuctionModel.findById(a._id).lean();
    expect(after!.bidCount).toBe(1);
    expect(after!.version).toBe(1);
    expect(await BidModel.countDocuments({ auctionId: a._id })).toBe(1);
  });

  it('web: concurrent ascending bids converge on the maximum with unique, strictly increasing seqs', async () => {
    const a = await liveAuction();
    const users = await Promise.all(Array.from({ length: 12 }, () => createUser()));
    const amounts = users.map((_, i) => 100_000 + i * 1_000);
    const res = await Promise.all(
      users.map((u, i) =>
        request(app)
          .post(`/v1/auctions/${a._id}/bids`)
          .set(WEB)
          .set('x-test-user', u)
          .set('Idempotency-Key', `bid-web-${i}-bbbbb`)
          .send({ amount: { amount: amounts[i], currency: 'USD' } }),
      ),
    );
    expect(res.some((r) => r.status === 201)).toBe(true);
    for (const r of res) expect([201, 409, 422]).toContain(r.status);

    const bids = await BidModel.find({ auctionId: a._id }).sort({ seq: 1 }).lean();
    const seqs = bids.map((b) => b.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    for (let i = 1; i < bids.length; i++) expect(bids[i]!.amountMinor).toBeGreaterThan(bids[i - 1]!.amountMinor);
    const after = await AuctionModel.findById(a._id).lean();
    expect(after!.highest!.amountMinor).toBe(Math.max(...amounts));
    expect(after!.bidCount).toBe(bids.length);
  });

  it('the same user cannot outbid themselves and a stale idempotent retry replays', async () => {
    const a = await liveAuction();
    const [u1, u2] = await Promise.all([createUser(), createUser()]);
    const first = await auctionsService.placeBid({ auctionId: a._id, userId: u1, client: 'web', amountMinor: 100_000, currency: 'USD', idempotencyKey: 'idem-bid-0001' });
    expect(first.replayed).toBe(false);
    await auctionsService.placeBid({ auctionId: a._id, userId: u2, client: 'web', amountMinor: 101_000, currency: 'USD', idempotencyKey: 'idem-bid-0002' });
    // retry of the first request after being outbid: returns the stored result, creates nothing
    const again = await auctionsService.placeBid({ auctionId: a._id, userId: u1, client: 'web', amountMinor: 100_000, currency: 'USD', idempotencyKey: 'idem-bid-0001' });
    expect(again.replayed).toBe(true);
    expect(again.result.bid.id).toBe(first.result.bid.id);
    expect(await BidModel.countDocuments({ auctionId: a._id })).toBe(2);
    await expect(
      auctionsService.placeBid({ auctionId: a._id, userId: u2, client: 'web', amountMinor: 105_000, currency: 'USD', idempotencyKey: 'idem-bid-0003' }),
    ).rejects.toMatchObject({ code: 'auction/self-outbid' });
  });

  it('rejects bids below the minimum increment with 422 and the floor', async () => {
    const a = await liveAuction();
    const [u1, u2] = await Promise.all([createUser(), createUser()]);
    await auctionsService.placeBid({ auctionId: a._id, userId: u1, client: 'web', amountMinor: 100_000, currency: 'USD', idempotencyKey: 'floor-bid-0001' });
    await expect(
      auctionsService.placeBid({ auctionId: a._id, userId: u2, client: 'web', amountMinor: 100_500, currency: 'USD', idempotencyKey: 'floor-bid-0002' }),
    ).rejects.toMatchObject({ status: 422, code: 'auction/bid-too-low' });
  });
});

describe('anti-snipe and closing', () => {
  it('extends closesAt by 2 minutes for a bid in the last 2 minutes, but not earlier', async () => {
    const t0 = new Date('2026-06-01T10:00:00.000Z');
    setClock(() => t0);
    const closesAt = new Date(t0.getTime() + 30 * 60_000);
    const a = await liveAuction({ opensAt: new Date(t0.getTime() - HOUR), closesAt });
    const [u1, u2] = await Promise.all([createUser(), createUser()]);

    await auctionsService.placeBid({ auctionId: a._id, userId: u1, client: 'web', amountMinor: 100_000, currency: 'USD', idempotencyKey: 'snipe-bid-0001' });
    expect((await AuctionModel.findById(a._id).lean())!.closesAt.getTime()).toBe(closesAt.getTime());

    setClock(() => new Date(closesAt.getTime() - 90_000));
    await auctionsService.placeBid({ auctionId: a._id, userId: u2, client: 'web', amountMinor: 101_000, currency: 'USD', idempotencyKey: 'snipe-bid-0002' });
    const after = await AuctionModel.findById(a._id).lean();
    expect(after!.closesAt.getTime()).toBe(closesAt.getTime() + 2 * 60_000);
    expect(after!.extensions).toBe(1);
  });

  it('returns auction/closed (410 mobile, 409 web) once the clock passes closesAt', async () => {
    const t0 = new Date('2026-06-01T10:00:00.000Z');
    setClock(() => t0);
    const a = await liveAuction({ opensAt: new Date(t0.getTime() - HOUR), closesAt: new Date(t0.getTime() + 60_000) });
    const u = await createUser();
    setClock(() => new Date(t0.getTime() + 61_000));
    const m = await request(app)
      .post(`/v1/auctions/${a._id}/bids`)
      .set(MOBILE)
      .set('x-test-user', u)
      .set('Idempotency-Key', 'closed-bid-0001')
      .send({ amount: { amount: 100_000, currency: 'USD', scale: 2 }, version: 0, acceptBinding: true });
    expect(m.status).toBe(410);
    const w = await request(app)
      .post(`/v1/auctions/${a._id}/bids`)
      .set(WEB)
      .set('x-test-user', u)
      .set('Idempotency-Key', 'closed-bid-0002')
      .send({ amount: { amount: 100_000, currency: 'USD' } });
    expect(w.status).toBe(409);
  });
});
