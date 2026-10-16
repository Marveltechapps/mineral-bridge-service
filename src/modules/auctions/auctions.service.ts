import type { FilterQuery } from 'mongoose';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../../common/errors/app-error.js';
import { idempotencyScope, runIdempotent } from '../../common/idempotency/idempotency.js';
import type { ApiClient } from '../../common/middleware/request-context.js';
import { addMs, MINUTE_MS, now } from '../../common/utils/clock.js';
import { opaqueId } from '../../common/utils/ids.js';
import { references } from '../../common/utils/references.js';
import { auctionHub } from '../../realtime/auction-hub.js';
import type { AuctionStatus, BidKind, IAuction, IBid } from '../../models/auction.model.js';
import { notifyUser } from '../notifications/notifications.service.js';
import { ordersService } from '../orders/orders.service.js';
import { auctionErrors, auctionMachine, bidderLabel, effectiveState, extendedCloseTime, nextValidBidMinor, reserveMet } from './auction.rules.js';
import type { EffectiveState } from './auction.rules.js';
import { auctionsRepository as repo } from './auctions.repository.js';

export type ListState = 'live' | 'upcoming' | 'ended';

export type PlaceBidResult = {
  bid: { id: string; amountMinor: number; currency: string; placedAt: string; kind: BidKind; leading: boolean };
  auction: { highestMinor: number; bidCount: number; closesAt: string; version: number; currency: string };
  isHighestBidder: boolean;
  minimumNextMinor: number;
};

export type PlaceBidInput = {
  auctionId: string;
  userId: string;
  client: ApiClient;
  amountMinor: number;
  currency: string;
  /** Mobile optimistic concurrency token; web omits it and relies on server-side retry. */
  expectedVersion?: number;
  idempotencyKey: string;
};

const MAX_WEB_RETRIES = 25;
const MAX_AUTOBID_STEPS = 60;

function stateFilter(state: ListState, at: Date): FilterQuery<IAuction> {
  switch (state) {
    case 'live':
      return { status: { $in: ['scheduled', 'live'] }, opensAt: { $lte: at }, closesAt: { $gt: at } };
    case 'upcoming':
      return { status: 'scheduled', opensAt: { $gt: at } };
    case 'ended':
      return { $or: [{ status: 'ended' }, { status: { $in: ['scheduled', 'live'] }, closesAt: { $lte: at } }] };
  }
}

const sortFor = (s: ListState): Record<string, 1 | -1> => (s === 'live' ? { closesAt: 1 } : s === 'upcoming' ? { opensAt: 1 } : { closesAt: -1 });

function currentSnapshot(a: IAuction) {
  return {
    highestBid: { amount: a.highest?.amountMinor ?? a.startingBid.amountMinor, currency: a.currency, scale: 2 },
    version: a.version,
    closesAt: a.closesAt.toISOString(),
  };
}

export const auctionsService = {
  /* ─────────────── lifecycle ─────────────── */

  async create(input: {
    name: string;
    quantityGrams: number;
    startingBidMinor: number;
    minimumIncrementMinor: number;
    reserveMinor?: number;
    currency?: string;
    opensAt: Date;
    closesAt: Date;
    productId?: string;
    grade?: string;
    origin?: string;
    description?: string;
    imageUrl?: string;
    assured?: boolean;
    status?: AuctionStatus;
  }): Promise<IAuction> {
    const currency = input.currency ?? 'USD';
    if (input.closesAt <= input.opensAt) throw unprocessable('closesAt must be after opensAt', { closesAt: 'Must be after opensAt' });
    const inc = input.minimumIncrementMinor;
    return repo.insert({
      reference: await references.auction(),
      name: input.name,
      productId: input.productId,
      quantityGrams: input.quantityGrams,
      grade: input.grade,
      origin: input.origin,
      description: input.description,
      imageUrl: input.imageUrl,
      assured: input.assured ?? false,
      currency,
      startingBid: { amountMinor: input.startingBidMinor, currency },
      minimumIncrement: { amountMinor: inc, currency },
      quickIncrements: [inc, inc * 2.5, inc * 5].map((n) => Math.round(n)),
      reserve: input.reserveMinor !== undefined ? { amountMinor: input.reserveMinor, currency } : undefined,
      opensAt: input.opensAt,
      closesAt: input.closesAt,
      originalClosesAt: input.closesAt,
      status: input.status ?? 'scheduled',
      version: 0,
      bidCount: 0,
      extensions: 0,
      specs: [],
      badges: input.assured ? [{ kind: 'assured', label: 'Mineral Bridge Assured' }] : [],
      settlementTerms: 'Escrow · 48h after close',
      mediaCount: 0,
    });
  },

  /** Admin/system status change guarded by the state machine (409 on illegal moves). */
  async transition(auctionId: string, to: AuctionStatus): Promise<IAuction> {
    const a = await repo.findById(auctionId);
    if (!a) throw notFound('auction/not-found', 'Auction not found');
    auctionMachine.assert(a.status, to);
    const updated = await repo.cas({ _id: a._id, version: a.version, status: a.status }, { $set: { status: to }, $inc: { version: 1 } });
    if (!updated) throw conflict('auction/concurrent-update', 'Auction changed; retry');
    return updated;
  },

  async get(auctionId: string): Promise<IAuction> {
    const a = await repo.findById(auctionId);
    if (!a) throw notFound('auction/not-found', 'Auction not found');
    return this.ensureFinalized(a);
  },

  /** Lazily settle an auction whose clock has run out (idempotent; also run by the sweeper). */
  async ensureFinalized(a: IAuction): Promise<IAuction> {
    if (a.outcome || a.status === 'draft' || a.status === 'cancelled') return a;
    if (a.closesAt > now() && a.status !== 'ended') return a;
    return (await this.finalize(a._id)) ?? a;
  },

  async finalize(auctionId: string): Promise<IAuction | null> {
    for (let i = 0; i < 4; i++) {
      const a = await repo.findById(auctionId);
      if (!a || a.outcome || a.status === 'draft' || a.status === 'cancelled') return a;
      const at = now();
      if (a.closesAt > at) return a;
      const result = !a.highest ? 'no_bids' : reserveMet(a) ? 'sold' : 'reserve_not_met';
      const updated = await repo.cas(
        { _id: a._id, version: a.version, 'outcome.finalizedAt': { $exists: false } },
        {
          $set: {
            status: 'ended',
            outcome: { result, winnerId: result === 'sold' ? a.highest?.bidderId : undefined, winningMinor: result === 'sold' ? a.highest?.amountMinor : undefined, finalizedAt: at },
          },
          $inc: { version: 1 },
        },
      );
      if (!updated) continue;
      let final = updated;
      if (result === 'sold' && updated.highest) {
        const order = await ordersService.createAuctionSettlementOrder({
          auctionId: a._id,
          name: a.name,
          imageUrl: a.imageUrl,
          grams: a.quantityGrams,
          winnerId: updated.highest.bidderId,
          amountMinor: updated.highest.amountMinor,
          currency: a.currency,
        });
        final = (await repo.cas({ _id: a._id }, { $set: { 'outcome.settlementOrderId': order._id } })) ?? updated;
        void notifyUser(updated.highest.bidderId, {
          event: 'auction.won',
          title: `You won ${a.name}`,
          body: 'Proceed to delivery details. Payment is held in escrow.',
          target: { type: 'auction', id: a._id },
          data: { auctionId: a._id, orderId: order._id },
        });
      }
      auctionHub.closed({
        auctionId: a._id,
        result,
        winnerId: final.outcome?.winnerId ?? null,
        winningMinor: final.outcome?.winningMinor ?? null,
        currency: a.currency,
        settlementOrderId: final.outcome?.settlementOrderId ?? null,
      });
      return final;
    }
    return repo.findById(auctionId);
  },

  /** Scheduler hook: finalise every auction whose clock has run out. */
  async sweepDue(limit = 100): Promise<number> {
    const due = await repo.list(
      { status: { $in: ['scheduled', 'live', 'paused'] }, closesAt: { $lte: now() }, 'outcome.finalizedAt': { $exists: false } },
      { closesAt: 1 },
      0,
      limit,
    );
    for (const a of due.rows) await this.finalize(a._id);
    return due.rows.length;
  },

  startSweeper(intervalMs = 5_000): () => void {
    const t = setInterval(() => void this.sweepDue().catch(() => undefined), intervalMs);
    t.unref();
    return () => clearInterval(t);
  },

  /* ─────────────── queries ─────────────── */

  async list(q: { states: ListState[]; skip: number; limit: number }) {
    const at = now();
    const states = q.states.length ? q.states : (['live'] as ListState[]);
    const filter: FilterQuery<IAuction> = states.length === 1 ? stateFilter(states[0]!, at) : { $or: states.map((s) => stateFilter(s, at)) };
    const { rows, total } = await repo.list(filter, sortFor(states[0]!), q.skip, q.limit);
    const [live, upcoming, ended] = await Promise.all((['live', 'upcoming', 'ended'] as ListState[]).map((s) => repo.count(stateFilter(s, at))));
    return { rows, total, counts: { live: live ?? 0, upcoming: upcoming ?? 0, ended: ended ?? 0 } };
  },

  async viewer(userId: string | undefined, auctions: IAuction[]) {
    if (!userId || auctions.length === 0) return null;
    const ids = auctions.map((a) => a._id);
    const [best, autos, reminders] = await Promise.all([repo.viewerBest(userId, ids), repo.viewerAutoBids(userId, ids), repo.viewerReminders(userId, ids)]);
    return {
      userId,
      best,
      autoBids: new Map(autos.map((x) => [x.auctionId, x.ceilingMinor])),
      reminders: new Set(reminders.map((x) => x.auctionId)),
    };
  },

  listBids: (auctionId: string, skip: number, limit: number) => repo.listBids(auctionId, skip, limit),

  async myBids(userId: string, filter: 'active' | 'won' | 'lost' | undefined, skip: number, limit: number) {
    const entries = await repo.auctionsBidOn(userId);
    const auctions = new Map((await repo.findMany(entries.map((e) => e.auctionId))).map((a) => [a._id, a]));
    const rows: { auction: IAuction; yourBidMinor: number; status: 'leading' | 'outbid' | 'won' | 'lost' }[] = [];
    for (const e of entries) {
      let a = auctions.get(e.auctionId);
      if (!a) continue;
      a = await this.ensureFinalized(a);
      const st = effectiveState(a, now());
      const youAreHighest = a.highest?.bidderId === userId;
      const status = st === 'ended' ? (a.outcome?.result === 'sold' && a.outcome.winnerId === userId ? 'won' : 'lost') : youAreHighest ? 'leading' : 'outbid';
      rows.push({ auction: a, yourBidMinor: e.best, status });
    }
    const counts = {
      active: rows.filter((r) => r.status === 'leading' || r.status === 'outbid').length,
      won: rows.filter((r) => r.status === 'won').length,
      lost: rows.filter((r) => r.status === 'lost').length,
    };
    const filtered = rows.filter((r) => (!filter ? true : filter === 'active' ? r.status === 'leading' || r.status === 'outbid' : r.status === filter));
    return { rows: filtered.slice(skip, skip + limit), total: filtered.length, counts };
  },

  async resultFor(auctionId: string, userId: string) {
    const a = await this.get(auctionId);
    if (effectiveState(a, now()) !== 'ended') {
      throw conflict('auction/not-closed', 'This auction has not closed yet.', { current: { closesAt: a.closesAt.toISOString() } });
    }
    const best = (await repo.viewerBest(userId, [a._id])).get(a._id);
    const sold = a.outcome?.result === 'sold';
    const won = sold && a.outcome?.winnerId === userId;
    const outcome = won ? 'won' : a.outcome?.result === 'reserve_not_met' && best !== undefined ? 'reserve_not_met' : best === undefined ? 'not_participated' : 'lost';
    return { auction: a, outcome, yourLastBidMinor: best ?? null, winningMinor: a.outcome?.winningMinor ?? null, settlementOrderId: won ? (a.outcome?.settlementOrderId ?? null) : null, unsold: !sold };
  },

  /* ─────────────── bidding ─────────────── */

  /**
   * Place a bid. Idempotent per `(user, auction, Idempotency-Key)`.
   *
   * Concurrency model: the auction document is the serialisation point. A bid is accepted with a
   * single compare-and-set on `version` (plus state/time guards in the same filter), so two
   * concurrent bids can never both be accepted against the same highest bid. Mobile clients send
   * the `version` they saw (409 `auction/outbid` with `current` when stale); web clients are
   * transparently retried against the fresh price until their amount stops being valid.
   */
  async placeBid(input: PlaceBidInput): Promise<{ result: PlaceBidResult; replayed: boolean }> {
    const outcome = await runIdempotent<PlaceBidResult>({
      scope: idempotencyScope(input.userId, 'bid', input.auctionId),
      key: input.idempotencyKey,
      body: { amountMinor: input.amountMinor, currency: input.currency, version: input.expectedVersion ?? null },
      successStatus: 201,
      fn: () => this.placeBidOnce(input),
    });
    return { result: outcome.result, replayed: outcome.replayed };
  },

  async placeBidOnce(input: PlaceBidInput): Promise<PlaceBidResult> {
    let lostRaces = 0;
    for (let attempt = 0; attempt <= MAX_WEB_RETRIES; attempt++) {
      const res = await this.tryPlace({
        auctionId: input.auctionId,
        bidderId: input.userId,
        client: input.client,
        amountMinor: input.amountMinor,
        currency: input.currency,
        kind: 'manual',
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
        lostRaces,
      });
      if (!res.ok) {
        lostRaces++;
        continue;
      }
      await this.afterBid(res.auction, res.bid, res.previous);
      await this.resolveAutoBids(input.auctionId);
      const fresh = (await repo.findById(input.auctionId)) ?? res.auction;
      return {
        bid: {
          id: res.bid._id,
          amountMinor: res.bid.amountMinor,
          currency: res.bid.currency,
          placedAt: res.bid.placedAt.toISOString(),
          kind: res.bid.kind,
          leading: fresh.highest?.bidId === res.bid._id,
        },
        auction: { highestMinor: fresh.highest?.amountMinor ?? 0, bidCount: fresh.bidCount, closesAt: fresh.closesAt.toISOString(), version: fresh.version, currency: fresh.currency },
        isHighestBidder: fresh.highest?.bidderId === input.userId,
        minimumNextMinor: nextValidBidMinor(fresh),
      };
    }
    const latest = await repo.findById(input.auctionId);
    throw auctionErrors.outbid(latest ? currentSnapshot(latest) : undefined);
  },

  async tryPlace(p: {
    auctionId: string;
    bidderId: string;
    client: ApiClient;
    amountMinor: number;
    currency: string;
    kind: BidKind;
    expectedVersion?: number;
    idempotencyKey?: string;
    lostRaces: number;
  }): Promise<{ ok: true; auction: IAuction; bid: IBid; previous: IAuction['highest'] } | { ok: false }> {
    const loaded = await repo.findById(p.auctionId);
    if (!loaded) throw notFound('auction/not-found', 'Auction not found');
    const a = await this.ensureFinalized(loaded);
    const at = now();
    const state: EffectiveState = effectiveState(a, at);
    if (state === 'ended' || state === 'cancelled') throw auctionErrors.closed(p.client);
    if (state !== 'live') throw auctionErrors.notOpen();
    if (p.currency !== a.currency) throw auctionErrors.currency(a.currency);
    if (a.highest?.bidderId === p.bidderId) throw auctionErrors.selfOutbid();

    const mobileVersioned = p.client === 'mobile' && p.expectedVersion !== undefined;
    if (mobileVersioned && a.version !== p.expectedVersion) throw auctionErrors.outbid(currentSnapshot(a));

    const floor = nextValidBidMinor(a);
    if (p.amountMinor < floor) {
      // We lost a race during this request and the price moved past the caller: that is an outbid, not a typo.
      if (p.lostRaces > 0) throw auctionErrors.outbid(currentSnapshot(a));
      throw auctionErrors.tooLow(floor, a.currency);
    }

    const closeExt = extendedCloseTime(a.closesAt, at);
    const bidId = opaqueId('bid');
    const updated = await repo.cas(
      {
        _id: a._id,
        version: a.version,
        status: { $in: ['scheduled', 'live'] },
        opensAt: { $lte: at },
        closesAt: { $gt: at },
      },
      {
        $set: {
          status: 'live',
          highest: { bidId, bidderId: p.bidderId, amountMinor: p.amountMinor, placedAt: at },
          ...(closeExt ? { closesAt: closeExt } : {}),
        },
        $inc: { version: 1, bidCount: 1, ...(closeExt ? { extensions: 1 } : {}) },
      },
    );
    if (!updated) {
      if (mobileVersioned) {
        const now2 = await repo.findById(a._id);
        throw auctionErrors.outbid(now2 ? currentSnapshot(now2) : undefined);
      }
      return { ok: false };
    }

    let bid: IBid | null = null;
    let lastErr: unknown;
    for (let i = 0; i < 3 && !bid; i++) {
      try {
        bid = await repo.insertBid({
          _id: bidId,
          auctionId: a._id,
          bidderId: p.bidderId,
          amountMinor: p.amountMinor,
          currency: a.currency,
          kind: p.kind,
          seq: updated.version,
          placedAt: at,
          idempotencyKey: p.idempotencyKey,
        });
      } catch (err) {
        lastErr = err;
      }
    }
    if (!bid) {
      throw new AppError({ status: 500, code: 'server/internal', message: lastErr instanceof Error ? lastErr.message : 'Failed to record bid', expose: false });
    }
    if (closeExt) auctionHub.extended({ auctionId: a._id, closesAt: updated.closesAt.toISOString(), version: updated.version });
    return { ok: true, auction: updated, bid, previous: a.highest };
  },

  async afterBid(auction: IAuction, bid: IBid, previous: IAuction['highest']): Promise<void> {
    auctionHub.bidPlaced({
      auctionId: auction._id,
      bidId: bid._id,
      bidderId: bid.bidderId,
      bidderLabel: bidderLabel(auction._id, bid.bidderId),
      amountMinor: bid.amountMinor,
      currency: bid.currency,
      placedAt: bid.placedAt.toISOString(),
      bidCount: auction.bidCount,
      highestMinor: bid.amountMinor,
      minimumNextMinor: nextValidBidMinor(auction),
      reserveMet: reserveMet(auction),
      version: auction.version,
      kind: bid.kind,
    });
    if (previous && previous.bidderId !== bid.bidderId) {
      auctionHub.outbid({
        auctionId: auction._id,
        auctionName: auction.name,
        outbidUserId: previous.bidderId,
        newHighestMinor: bid.amountMinor,
        yourBidMinor: previous.amountMinor,
        currency: bid.currency,
        closesAt: auction.closesAt.toISOString(),
      });
      void notifyUser(previous.bidderId, {
        event: 'auction.outbid',
        title: `You have been outbid on ${auction.name}`,
        body: `New highest bid ${(bid.amountMinor / 100).toLocaleString('en-US', { style: 'currency', currency: bid.currency })}`,
        target: { type: 'auction', id: auction._id },
        data: { auctionId: auction._id, currentBid: { amount: bid.amountMinor, currency: bid.currency } },
      });
    }
  },

  /** Proxy bidding: auto-bidders respond in minimum increments up to their ceilings. */
  async resolveAutoBids(auctionId: string): Promise<void> {
    for (let i = 0; i < MAX_AUTOBID_STEPS; i++) {
      const a = await repo.findById(auctionId);
      if (!a || effectiveState(a, now()) !== 'live') return;
      const floor = nextValidBidMinor(a);
      const [cand] = await repo.autoBidCandidates(auctionId, a.highest?.bidderId, floor);
      if (!cand) return;
      const rival = a.highest ? await repo.findAutoBid(auctionId, a.highest.bidderId) : null;
      let amount = floor;
      if (rival && rival.ceilingMinor >= floor) amount = Math.max(floor, rival.ceilingMinor + a.minimumIncrement.amountMinor);
      amount = Math.min(cand.ceilingMinor, amount);
      if (amount < floor) return;
      try {
        const res = await this.tryPlace({
          auctionId,
          bidderId: cand.userId,
          client: 'web',
          amountMinor: amount,
          currency: a.currency,
          kind: 'auto',
          lostRaces: 0,
        });
        if (res.ok) await this.afterBid(res.auction, res.bid, res.previous);
      } catch (err) {
        if (err instanceof AppError && (err.code === 'auction/bid-too-low' || err.code === 'auction/self-outbid')) continue;
        return;
      }
    }
  },

  async setAutoBid(auctionId: string, userId: string, ceilingMinor: number, currency: string, client: ApiClient) {
    const a = await this.get(auctionId);
    const st = effectiveState(a, now());
    if (st === 'ended' || st === 'cancelled') throw auctionErrors.closed(client);
    if (st !== 'live' && st !== 'upcoming') throw auctionErrors.notOpen();
    if (currency !== a.currency) throw auctionErrors.currency(a.currency);
    const floor = nextValidBidMinor(a);
    if (ceilingMinor < floor) throw auctionErrors.tooLow(floor, a.currency);
    const ab = await repo.upsertAutoBid(auctionId, userId, ceilingMinor, currency);
    await this.resolveAutoBids(auctionId);
    const fresh = (await repo.findById(auctionId)) ?? a;
    return { ceilingMinor: ab.ceilingMinor, currentMinor: fresh.highest?.amountMinor ?? fresh.startingBid.amountMinor, currency };
  },

  async clearAutoBid(auctionId: string, userId: string) {
    await this.get(auctionId);
    await repo.deactivateAutoBid(auctionId, userId);
  },

  async watch(auctionId: string, userId: string, notifyOnSimilar: boolean) {
    await this.get(auctionId);
    await repo.upsertWatch(auctionId, userId, 'watch', { notifyOnSimilar });
  },

  async setReminder(auctionId: string, userId: string, channels: string[]) {
    const a = await this.get(auctionId);
    const st = effectiveState(a, now());
    if (st === 'ended' || st === 'cancelled') throw conflict('auction/closed', 'This auction has closed.');
    const notifyAt = st === 'upcoming' ? a.opensAt : addMs(a.closesAt, -15 * MINUTE_MS);
    await repo.upsertWatch(auctionId, userId, 'reminder', { channels, notifyAt });
    return { notifyAt };
  },

  async clearReminder(auctionId: string, userId: string) {
    await this.get(auctionId);
    await repo.deleteWatch(auctionId, userId, 'reminder');
  },

  assertParticipant(userId: string | undefined): string {
    if (!userId) throw forbidden('auth/forbidden', 'Sign in required');
    return userId;
  },
};
