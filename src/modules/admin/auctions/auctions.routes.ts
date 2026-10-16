import { z } from 'zod';
import { AppError, conflict, unprocessable } from '../../../common/errors/app-error.js';
import { nextId } from '../../../common/db/sequence.js';
import { withTx } from '../../../common/db/transaction.js';
import { assertIfMatch, docEtag, setEtag } from '../../../common/http/etag.js';
import { Auction, AuctionEvent, Bid, Listing, VaultLot } from '../../../models/trading.models.js';
import { Dispute, User } from '../../../models/people.models.js';
import { auditActor } from '../shared/staff-context.js';
import { recordAudit } from '../../audit/audit.service.js';
import { BUYER_ACCESS } from '../shared/enums.js';
import { action, and, boolQ, escapeRegex, iso, oneOf, pageOf, paging, searchFilter, sortSpec, intQ, dateQ } from '../shared/http.js';
import { notifyStaff } from '../shared/notify.js';
import { sendCustomerMessage } from '../shared/messaging.js';
import { adminMoneySchema, adminUnitPriceSchema, outMoney, parseMoney, parsePositiveMoney, parseUnitPrice } from '../shared/money.js';
import { loadUserMap } from '../shared/refs.js';
import { route, type AdminRouteDef } from '../shared/route-kit.js';
import { loadRateIndex, realisableOf } from '../pricing/rates.service.js';
import { createListingFromLot } from '../listings/listings.service.js';
import { lotSummary, suggestionsFor } from '../vault/vault.service.js';
import {
  AUCTION_SORT,
  EVENT_REPLAY_MS,
  MAX_DURATION_MS,
  MIN_DURATION_MS,
  OPEN_STATUSES,
  auctionBus,
  auctionDetail,
  auctionSummary,
  bidDto,
  emitAuctionEvent,
  requireAuction,
  staleAuction,
  stateEventData,
} from './auctions.service.js';

type StoredMoney = ReturnType<typeof parseMoney>;

const termsSchema = z.object({
  startingBid: adminMoneySchema,
  reserve: adminMoneySchema.nullable().optional(),
  increment: adminMoneySchema,
  opensAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime(),
  access: z.enum(BUYER_ACCESS).default('all_verified'),
});

const createBody = termsSchema.extend({
  lotId: z.string().min(1),
  publish: z.boolean().default(true),
  sourceListingId: z.string().nullable().optional(),
});

const patchBody = termsSchema.partial().strict();

const relistBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('lower_reserve'), reserve: adminMoneySchema, endsAt: z.string().datetime() }),
  z.object({ action: z.literal('catalog'), askPrice: adminUnitPriceSchema }),
  z.object({ action: z.literal('vault_reserve'), reason: z.string().trim().min(3).max(500) }),
]);

function assertTerms(t: { startingBid: StoredMoney; reserve?: StoredMoney | null; increment: StoredMoney; opensAt: Date; endsAt: Date }) {
  const cur = t.startingBid.currency;
  if ((t.reserve && t.reserve.currency !== cur) || t.increment.currency !== cur) {
    throw unprocessable('All amounts must use the same currency', { currency: 'Mixed currencies' });
  }
  if (t.reserve && t.reserve.amountMinor < t.startingBid.amountMinor) {
    throw new AppError({ status: 422, code: 'rule/reserve-below-start', message: 'Reserve cannot be below the starting bid.', fields: { reserve: 'Must be ≥ starting bid' } });
  }
  const dur = t.endsAt.getTime() - t.opensAt.getTime();
  if (dur < MIN_DURATION_MS || dur > MAX_DURATION_MS) {
    throw new AppError({ status: 422, code: 'rule/duration', message: 'Auction duration must be between 1 hour and 14 days.', fields: { endsAt: '1 h – 14 days' } });
  }
}



export const auctionRoutes: AdminRouteDef[] = [
  route(53, 'GET /auctions', ['auctions', 'view'], async (req, res) => {
    const status = oneOf(req.query.status, ['live', 'upcoming', 'ended'] as const, 'status');
    if (!status) throw unprocessable('status is required', { status: 'live | upcoming | ended' });
    const statuses = status === 'live' ? ['live', 'paused'] : status === 'upcoming' ? ['upcoming'] : ['ended', 'cancelled'];
    const flagged = boolQ(req.query.flagged);
    const closingToday = boolQ(req.query.closingToday);
    const dayEnd = new Date(); dayEnd.setUTCHours(23, 59, 59, 999);
    let search = searchFilter(req.query.q, ['auctionId', 'mineral.name', 'lotId']);
    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      const people = await User.find({ $or: [{ name: new RegExp(escapeRegex(req.query.q.trim()), 'i') }, { org: new RegExp(escapeRegex(req.query.q.trim()), 'i') }] }).limit(50).lean();
      const ids = people.map((p) => p.userId);
      if (ids.length) search = { $or: [...((search as { $or: unknown[] }).$or), { leaderId: { $in: ids } }, { winnerId: { $in: ids } }] };
    }
    const filter = and({ status: { $in: statuses } }, flagged !== undefined && { flagged }, closingToday && { status: 'live', endsAt: { $lte: dayEnd } }, search);
    res.json(
      await pageOf(Auction, {
        filter,
        sort: sortSpec(req, AUCTION_SORT, status === 'ended' ? { endsAt: -1, _id: 1 } : { endsAt: 1, _id: 1 }),
        paging: paging(req),
        map: async (docs: any[]) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          const users = await loadUserMap(docs.flatMap((d) => [d.leaderId, d.winnerId]));
          return docs.map((d) => auctionSummary(d, users));
        },
        counts: async () => ({
          live: await Auction.countDocuments({ status: { $in: ['live', 'paused'] } }),
          upcoming: await Auction.countDocuments({ status: 'upcoming' }),
          ended: await Auction.countDocuments({ status: { $in: ['ended', 'cancelled'] } }),
        }),
      }),
    );
  }),

  route(54, 'GET /auctions/eligible-lots', ['auctions', 'view'], async (_req, res) => {
    const [lots, idx] = await Promise.all([VaultLot.find({ status: 'in_vault' }).sort({ heldSince: 1 }).limit(200).lean(), loadRateIndex()]);
    res.json({
      data: lots.map((l) => {
        const { realisable } = realisableOf(l, idx);
        const s = suggestionsFor(l.costBasis, realisable);
        return { lot: lotSummary(l), costBasis: outMoney(l.costBasis), realisable: outMoney(realisable), suggested: s ? { startingBid: s.startingBid, reserve: s.reserve, increment: s.increment } : null };
      }),
    });
  }),

  route(55, 'POST /auctions', ['auctions', 'edit'], async (req, res) => {
    const b = req.body as z.infer<typeof createBody>;
    const actor = auditActor(req);
    const now = new Date();
    const startingBid = parsePositiveMoney(b.startingBid, 'startingBid');
    const reserve = b.reserve ? parsePositiveMoney(b.reserve, 'reserve') : null;
    const increment = parsePositiveMoney(b.increment, 'increment');
    const live = b.publish && !b.opensAt;
    const opensAt = live ? now : b.opensAt ? new Date(b.opensAt) : null;
    if (!opensAt) throw unprocessable('Set an opening time or publish now', { opensAt: 'Required when saving as upcoming' });
    const endsAt = new Date(b.endsAt);
    assertTerms({ startingBid, reserve, increment, opensAt, endsAt });
    const status = live || (b.publish && opensAt.getTime() <= now.getTime()) ? 'live' : 'upcoming';

    const { auction, auditId } = await withTx(async (session) => {
      const auctionId = await nextId('auction', session);
      let quantity: { value: number; unit: string } | undefined;
      let from: 'in_vault' | 'listed' = 'in_vault';
      if (b.sourceListingId) {
        const listing = await Listing.findOneAndUpdate({ listingId: b.sourceListingId, lotId: b.lotId, status: { $in: ['live', 'paused', 'scheduled'] } }, { $set: { status: 'ended', endedAt: now } }, { new: false, session }).lean();
        if (!listing) throw conflict('conflict/stale-state', `${b.sourceListingId} is no longer available to move to auction.`);
        quantity = listing.quantityLeft;
        from = 'listed';
      }
      const claimed = await VaultLot.findOneAndUpdate(
        { lotId: b.lotId, status: from },
        { $set: { status: 'in_auction', auctionId }, $unset: { listingId: 1 }, $push: { allocationHistory: { title: status === 'live' ? 'Auction published' : 'Auction scheduled', sub: auctionId, date: now } } },
        { new: true, session },
      ).lean();
      if (!claimed) throw conflict('conflict/stale-state', `${b.lotId} is not eligible for auction (already allocated or held).`);
      const idx = await loadRateIndex();
      const { realisable } = realisableOf(claimed, idx);
      const [created] = await Auction.create(
        [
          {
            auctionId,
            status,
            lotId: b.lotId,
            mineral: claimed.mineral,
            grade: claimed.grade,
            quantity: quantity ?? claimed.quantity,
            startingBid,
            reserve: reserve ?? undefined,
            increment,
            opensAt,
            endsAt,
            durationMs: endsAt.getTime() - opensAt.getTime(),
            access: b.access,
            costBasis: claimed.costBasis,
            realisable,
            sourceListingId: b.sourceListingId ?? undefined,
            createdBy: actor.staffId,
          },
        ],
        { session },
      );
      const auditId = await recordAudit({
        actor,
        category: 'vault',
        action: status === 'live' ? 'Published auction' : 'Saved auction as upcoming',
        record: { type: 'auction', id: auctionId, label: auctionId },
        after: { lotId: b.lotId, status, startingBid: b.startingBid, reserve: b.reserve, endsAt: b.endsAt, access: b.access, sourceListingId: b.sourceListingId },
        req,
        session,
        activity: { text: `Auction ${auctionId} ${status === 'live' ? 'went live' : 'scheduled'} for ${b.lotId}`, meta: `${claimed.mineral?.name} · ${claimed.quantity.value} ${claimed.quantity.unit}`, kind: 'auction' },
      });
      return { auction: created.toObject(), auditId };
    });
    await emitAuctionEvent(auction.auctionId, 'state', stateEventData(auction));
    res.status(201).json(action(auctionDetail(auction, new Map()), `Auction published for ${b.lotId}`.replace('published', status === 'live' ? 'published' : 'saved as upcoming'), auditId));
  }, { body: createBody }),

  route(56, 'GET /auctions/:auctionId', ['auctions', 'view'], async (req, res) => {
    const a = await requireAuction(String(req.params.auctionId));
    setEtag(res, docEtag(a));
    res.json(auctionDetail(a, await loadUserMap([a.leaderId, a.winnerId])));
  }),

  route(57, 'PATCH /auctions/:auctionId', ['auctions', 'edit'], async (req, res) => {
    const auctionId = String(req.params.auctionId);
    const a = await requireAuction(auctionId);
    assertIfMatch(req, docEtag(a));
    if (a.status !== 'upcoming') throw staleAuction(a, 'edit');
    const b = req.body as z.infer<typeof patchBody>;
    const startingBid = b.startingBid ? parsePositiveMoney(b.startingBid, 'startingBid') : a.startingBid;
    const reserve = b.reserve === null ? null : b.reserve ? parsePositiveMoney(b.reserve, 'reserve') : a.reserve ?? null;
    const increment = b.increment ? parsePositiveMoney(b.increment, 'increment') : a.increment;
    const opensAt = b.opensAt ? new Date(b.opensAt) : a.opensAt;
    const endsAt = b.endsAt ? new Date(b.endsAt) : a.endsAt;
    assertTerms({ startingBid, reserve, increment, opensAt, endsAt });
    const set: Record<string, unknown> = { startingBid, increment, opensAt, endsAt, durationMs: endsAt.getTime() - opensAt.getTime() };
    const unset: Record<string, 1> = {};
    if (reserve) set.reserve = reserve; else unset.reserve = 1;
    if (b.access) set.access = b.access;
    const actor = auditActor(req);
    const { updated, auditId } = await withTx(async (session) => {
      const updated = await Auction.findOneAndUpdate({ _id: a._id, status: 'upcoming', __v: a.__v }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}), $inc: { __v: 1 } }, { new: true, session }).lean();
      if (!updated) throw new AppError({ status: 412, code: 'conflict/etag-mismatch', message: 'Someone else changed this — reload and try again.' });
      const auditId = await recordAudit({ actor, category: 'vault', action: 'Edited upcoming auction', record: { type: 'auction', id: auctionId, label: auctionId }, before: { startingBid: outMoney(a.startingBid), reserve: outMoney(a.reserve), endsAt: iso(a.endsAt), access: a.access }, after: b, req, session });
      return { updated, auditId };
    });
    setEtag(res, docEtag(updated));
    res.json(action(auctionDetail(updated, new Map()), `${auctionId} updated`, auditId));
  }, { body: patchBody }),

  route(58, 'POST /auctions/:auctionId/go-live', ['auctions', 'edit'], async (req, res) => {
    const auctionId = String(req.params.auctionId);
    const a = await requireAuction(auctionId);
    if (a.status !== 'upcoming') throw staleAuction(a, 'go live');
    const now = new Date();
    const durationMs = a.durationMs ?? a.endsAt.getTime() - a.opensAt.getTime();
    const endsAt = new Date(now.getTime() + Math.max(MIN_DURATION_MS, durationMs));
    const actor = auditActor(req);
    const { updated, auditId } = await withTx(async (session) => {
      const updated = await Auction.findOneAndUpdate({ auctionId, status: 'upcoming' }, { $set: { status: 'live', opensAt: now, endsAt } }, { new: true, session }).lean();
      if (!updated) throw conflict('conflict/stale-state', `${auctionId} is no longer upcoming.`);
      const auditId = await recordAudit({ actor, category: 'vault', action: 'Opened auction now', record: { type: 'auction', id: auctionId, label: auctionId }, before: { status: 'upcoming' }, after: { status: 'live', endsAt: endsAt.toISOString() }, req, session, activity: { text: `Auction ${auctionId} is now live`, kind: 'auction' } });
      return { updated, auditId };
    });
    await emitAuctionEvent(auctionId, 'state', stateEventData(updated));
    res.json(action(auctionDetail(updated, new Map()), `${auctionId} published — now live`, auditId));
  }),

  route(59, 'GET /auctions/:auctionId/bids', ['auctions', 'view'], async (req, res) => {
    const a = await requireAuction(String(req.params.auctionId));
    const limit = Math.min(200, Math.max(1, intQ(req.query.limit, 'limit') ?? 50));
    const before = dateQ(req.query.before, 'before');
    const rows = await Bid.find(and({ auctionId: a.auctionId }, before && { at: { $lt: before } })).sort({ at: -1, _id: -1 }).limit(limit + 1).lean();
    const page = rows.slice(0, limit);
    const users = await loadUserMap(page.map((b) => b.bidderId));
    res.json({
      data: page.map((b) => bidDto(b, users, a)),
      meta: { bidderCount: (a.bidderIds ?? []).length, nextBefore: rows.length > limit ? iso(page[page.length - 1]!.at) : null },
    });
  }),

  // #60 — Server-Sent Events. Events are persisted (AuctionEvent) so Last-Event-ID replays for 10 minutes and
  // streams work across instances; the in-process bus only wakes a stream early.
  route(60, 'GET /auctions/:auctionId/bids/stream', ['auctions', 'view'], async (req, res) => {
    const a = await requireAuction(String(req.params.auctionId));
    const auctionId = a.auctionId;
    const header = req.header('last-event-id') ?? (typeof req.query.lastEventId === 'string' ? req.query.lastEventId : '');
    let last = Number.parseInt(header, 10);
    const resuming = Number.isFinite(last);
    if (!resuming) {
      const tail = await AuctionEvent.findOne({ auctionId }).sort({ seq: -1 }).lean();
      last = tail?.seq ?? 0;
    }
    res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    // Fresh connections start with the current state so the UI never waits for the next change.
    if (!resuming) res.write(`event: state\ndata: ${JSON.stringify(stateEventData(a))}\n\n`);

    let closed = false;
    let flushing = false;
    const flush = async () => {
      if (closed || flushing) return;
      flushing = true;
      try {
        const events = await AuctionEvent.find({ auctionId, seq: { $gt: last }, createdAt: { $gte: new Date(Date.now() - EVENT_REPLAY_MS) } }).sort({ seq: 1 }).limit(500).lean();
        for (const ev of events) {
          res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
          last = ev.seq;
        }
      } catch {
        /* transient DB error: next tick retries */
      } finally {
        flushing = false;
      }
    };
    await flush();
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => void flush(), 1000);
      const beat = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, 15_000);
      const wake = () => void flush();
      auctionBus.on(auctionId, wake);
      const done = () => {
        if (closed) return;
        closed = true;
        clearInterval(poll);
        clearInterval(beat);
        auctionBus.off(auctionId, wake);
        res.end();
        resolve();
      };
      req.on('close', done);
      res.on('close', done);
    });
  }, { sse: true }),

  route(61, 'POST /auctions/:auctionId/pause', ['auctions', 'edit'], async (req, res) => {
    const auctionId = String(req.params.auctionId);
    const { reason } = req.body as { reason: string };
    const a = await requireAuction(auctionId);
    if (a.status !== 'live') throw staleAuction(a, 'pause');
    const actor = auditActor(req);
    const now = new Date();
    const { updated, auditId } = await withTx(async (session) => {
      const updated = await Auction.findOneAndUpdate({ auctionId, status: 'live' }, { $set: { status: 'paused', pausedAt: now } }, { new: true, session }).lean();
      if (!updated) throw conflict('conflict/stale-state', `${auctionId} changed state — refresh and try again.`);
      const auditId = await recordAudit({ actor, category: 'vault', action: 'Paused auction', record: { type: 'auction', id: auctionId, label: auctionId }, before: { status: 'live' }, after: { status: 'paused' }, reason, req, session, activity: { text: `Auction ${auctionId} paused`, meta: reason, kind: 'auction', severity: 'warn' } });
      return { updated, auditId };
    });
    await emitAuctionEvent(auctionId, 'state', stateEventData(updated));
    res.json(action(auctionDetail(updated, await loadUserMap([updated.leaderId])), `${auctionId} paused — bidding suspended`, auditId));
  }, { body: z.object({ reason: z.string().trim().min(3, 'A reason is required').max(500) }) }),

  route(62, 'POST /auctions/:auctionId/resume', ['auctions', 'edit'], async (req, res) => {
    const auctionId = String(req.params.auctionId);
    const { reason } = req.body as { reason?: string };
    const a = await requireAuction(auctionId);
    if (a.status !== 'paused') throw staleAuction(a, 'resume');
    const actor = auditActor(req);
    const now = new Date();
    const pausedMs = a.pausedAt ? Math.max(0, now.getTime() - a.pausedAt.getTime()) : 0;
    const { updated, auditId } = await withTx(async (session) => {
      const updated = await Auction.findOneAndUpdate({ auctionId, status: 'paused' }, { $set: { status: 'live', endsAt: new Date(a.endsAt.getTime() + pausedMs) }, $unset: { pausedAt: 1 } }, { new: true, session }).lean();
      if (!updated) throw conflict('conflict/stale-state', `${auctionId} changed state — refresh and try again.`);
      const auditId = await recordAudit({ actor, category: 'vault', action: 'Resumed auction', record: { type: 'auction', id: auctionId, label: auctionId }, before: { status: 'paused' }, after: { status: 'live', endsAt: updated.endsAt.toISOString() }, reason, req, session, activity: { text: `Auction ${auctionId} resumed`, kind: 'auction' } });
      return { updated, auditId };
    });
    await emitAuctionEvent(auctionId, 'state', stateEventData(updated));
    res.json(action(auctionDetail(updated, await loadUserMap([updated.leaderId])), `${auctionId} resumed`, auditId));
  }, { body: z.object({ reason: z.string().trim().max(500).optional() }).default({}) }),

  route(63, 'POST /auctions/:auctionId/cancel', ['auctions', 'edit'], async (req, res) => {
    const auctionId = String(req.params.auctionId);
    const { reason } = req.body as { reason: string };
    const a = await requireAuction(auctionId);
    if (!(OPEN_STATUSES as readonly string[]).includes(a.status)) throw staleAuction(a, 'cancel');
    const actor = auditActor(req);
    const now = new Date();
    const { updated, auditId } = await withTx(async (session) => {
      const updated = await Auction.findOneAndUpdate({ auctionId, status: { $in: [...OPEN_STATUSES] } }, { $set: { status: 'cancelled', outcome: 'cancelled', cancelReason: reason, 'resolution.closedAt': now }, $unset: { pausedAt: 1 } }, { new: true, session }).lean();
      if (!updated) throw staleAuction(a, 'cancel');
      await VaultLot.updateOne({ lotId: a.lotId }, { $set: { status: 'in_vault' }, $unset: { auctionId: 1 }, $push: { allocationHistory: { title: 'Auction cancelled', sub: `${auctionId} · ${reason}`, date: now } } }, { session });
      const auditId = await recordAudit({ actor, category: 'vault', action: 'Cancelled auction', record: { type: 'auction', id: auctionId, label: auctionId }, before: { status: a.status }, after: { status: 'cancelled', lotReturned: a.lotId }, reason, req, session, activity: { text: `Auction ${auctionId} cancelled`, meta: reason, kind: 'auction', severity: 'warn' } });
      return { updated, auditId };
    });
    await emitAuctionEvent(auctionId, 'state', stateEventData(updated));
    // Bidders are told; escrow holds are released by the payments rail (no hold is taken until settlement).
    await Promise.all(
      (a.bidderIds ?? []).map((userId: string) =>
        sendCustomerMessage({ userId, subject: `Auction ${auctionId} cancelled`, body: `Auction ${auctionId} was cancelled by Mineral Bridge. Any funds held for your bid are released.`, channels: ['in_app'], related: { type: 'auction', id: auctionId }, sentBy: actor.staffId }).catch(() => undefined),
      ),
    );
    res.json(action(auctionDetail(updated, new Map()), `${auctionId} cancelled — lot returned to vault`, auditId));
  }, { body: z.object({ reason: z.string().trim().min(3, 'A reason is required').max(500) }) }),

  route(64, 'POST /auctions/:auctionId/flags', ['auctions', 'edit'], async (req, res) => {
    const auctionId = String(req.params.auctionId);
    const b = req.body as { kind: 'linked_accounts' | 'velocity' | 'other'; note: string; bidIds?: string[] };
    const a = await requireAuction(auctionId);
    const actor = auditActor(req);
    const now = new Date();
    const { flagId, auditId } = await withTx(async (session) => {
      const flagId = await nextId('flag', session);
      await Auction.updateOne({ auctionId }, { $set: { flagged: true }, $push: { flags: { flagId, kind: b.kind, note: b.note, bidIds: b.bidIds ?? [], by: actor.staffId, at: now } } }, { session });
      if (b.kind === 'linked_accounts' && b.bidIds?.length) await Bid.updateMany({ auctionId, bidId: { $in: b.bidIds } }, { $set: { linkedAccount: true } }, { session });
      const auditId = await recordAudit({ actor, category: 'compliance', action: 'Flagged suspicious auction activity', record: { type: 'auction', id: auctionId, label: auctionId }, after: { flagId, kind: b.kind, bidIds: b.bidIds }, reason: b.note, req, session, activity: { text: `Auction ${auctionId} flagged: ${b.kind.replace('_', ' ')}`, meta: b.note, kind: 'auction', severity: 'warn' } });
      return { flagId, auditId };
    });
    await emitAuctionEvent(auctionId, 'risk', { kind: b.kind, text: b.note, bidIds: b.bidIds ?? [] });
    await notifyStaff({ module: 'compliance', text: `${auctionId} flagged for ${b.kind.replace('_', ' ')}`, meta: b.note, severity: 'high', target: { type: 'auction', id: a.auctionId } });
    res.status(201).json(action({ flagId }, `${auctionId} flagged — compliance notified, bids stay live`, auditId));
  }, { body: z.object({ kind: z.enum(['linked_accounts', 'velocity', 'other']), note: z.string().trim().min(3).max(1000), bidIds: z.array(z.string()).max(100).optional() }) }),

  route(65, 'POST /auctions/:auctionId/escalate', ['auctions', 'edit'], async (req, res) => {
    const auctionId = String(req.params.auctionId);
    const { note, pauseAuction } = req.body as { note: string; pauseAuction: boolean };
    const a = await requireAuction(auctionId);
    const actor = auditActor(req);
    const now = new Date();
    const { disputeId, auditId, paused } = await withTx(async (session) => {
      const disputeId = await nextId('dispute', session);
      const value = a.currentBid ?? a.startingBid;
      await Dispute.create(
        [{ disputeId, linked: { type: 'auction', id: auctionId }, type: 'Auction integrity review', partyId: a.leaderId, status: 'compliance_hold', openedAt: now, valueAtRisk: value, escalatedAt: now, createdBy: actor.staffId, raisedBy: { kind: 'staff', id: actor.staffId }, messages: [{ id: await nextId('disputeMessage', session), from: 'admin', author: actor.name, text: note, at: now }] }],
        { session },
      );
      let paused = false;
      if (pauseAuction && a.status === 'live') {
        const r = await Auction.updateOne({ auctionId, status: 'live' }, { $set: { status: 'paused', pausedAt: now } }, { session });
        paused = r.modifiedCount > 0;
      }
      const auditId = await recordAudit({ actor, category: 'compliance', action: 'Escalated auction to compliance', record: { type: 'auction', id: auctionId, label: auctionId }, after: { disputeId, paused }, reason: note, req, session, activity: { text: `Auction ${auctionId} escalated to compliance (${disputeId})`, meta: note, kind: 'dispute', severity: 'warn', ref: { type: 'dispute', id: disputeId } } });
      return { disputeId, auditId, paused };
    });
    if (paused) await emitAuctionEvent(auctionId, 'state', { status: 'paused', endsAt: iso(a.endsAt) });
    await notifyStaff({ module: 'compliance', text: `${disputeId} opened from auction ${auctionId}`, meta: note, severity: 'high', target: { type: 'dispute', id: disputeId } });
    res.status(201).json(action({ disputeId }, `${auctionId} escalated — ${disputeId} opened`, auditId));
  }, { body: z.object({ note: z.string().trim().min(3).max(1000), pauseAuction: z.boolean().default(false) }) }),

  route(66, 'POST /auctions/:auctionId/relist', ['auctions', 'edit'], async (req, res) => {
    const auctionId = String(req.params.auctionId);
    const b = req.body as z.infer<typeof relistBody>;
    const a = await requireAuction(auctionId);
    const eligible = (a.status === 'ended' && a.outcome === 'reserve_not_met') || a.status === 'cancelled';
    if (!eligible || a.relisted?.action) {
      throw conflict('conflict/stale-state', a.relisted?.action ? `${auctionId} was already relisted.` : `${auctionId} cannot be relisted (${a.status}${a.outcome ? `, ${a.outcome}` : ''}).`, { details: { status: a.status, outcome: a.outcome } });
    }
    const actor = auditActor(req);
    const now = new Date();
    const out = await withTx(async (session) => {
      // Guard: only one relist per auction, and the lot must be back in the vault.
      const mark = await Auction.updateOne({ auctionId, 'relisted.action': { $exists: false } }, { $set: { relisted: { action: b.action, at: now, by: actor.staffId } } }, { session });
      if (mark.modifiedCount === 0) throw conflict('conflict/stale-state', `${auctionId} was already relisted.`);
      let result: { auctionId?: string; listingId?: string; lotId: string };
      let message: string;
      if (b.action === 'lower_reserve') {
        const reserve = parsePositiveMoney(b.reserve, 'reserve');
        if (a.reserve && reserve.amountMinor >= a.reserve.amountMinor) throw new AppError({ status: 422, code: 'rule/reserve-not-lower', message: 'The new reserve must be lower than the previous one.', fields: { reserve: 'Must be lower than the previous reserve' } });
        const endsAt = new Date(b.endsAt);
        assertTerms({ startingBid: a.startingBid, reserve, increment: a.increment, opensAt: now, endsAt });
        const newId = await nextId('auction', session);
        const claimed = await VaultLot.findOneAndUpdate({ lotId: a.lotId, status: 'in_vault' }, { $set: { status: 'in_auction', auctionId: newId } }, { new: true, session }).lean();
        if (!claimed) throw conflict('conflict/stale-state', `${a.lotId} is not back in the vault.`);
        await Auction.create(
          [{ auctionId: newId, status: 'live', lotId: a.lotId, mineral: a.mineral, grade: a.grade, quantity: a.quantity, startingBid: a.startingBid, reserve, increment: a.increment, opensAt: now, endsAt, durationMs: endsAt.getTime() - now.getTime(), access: a.access, costBasis: a.costBasis, realisable: a.realisable, relistedFrom: auctionId, createdBy: actor.staffId }],
          { session },
        );
        await Auction.updateOne({ auctionId }, { $set: { 'relisted.refId': newId } }, { session });
        result = { auctionId: newId, lotId: a.lotId };
        message = `${auctionId} relisted at a lower reserve`;
      } else if (b.action === 'catalog') {
        const { listing } = await createListingFromLot({ lotId: a.lotId, askPrice: parseUnitPrice(b.askPrice, 'askPrice'), sourceAuctionId: auctionId, createdBy: actor.staffId, confirmBelowCost: true }, session);
        await Auction.updateOne({ auctionId }, { $set: { 'relisted.refId': listing.listingId } }, { session });
        result = { listingId: listing.listingId, lotId: a.lotId };
        message = 'Lot moved to the fixed-price catalog';
      } else {
        const r = await VaultLot.updateOne(
          { lotId: a.lotId, status: 'in_vault' },
          { $set: { status: 'reserved', hold: { reason: b.reason, reviewOn: new Date(now.getTime() + 14 * 86_400_000).toISOString().slice(0, 10), visibleInUnallocatedQueue: true, heldBy: actor.staffId, at: now } }, $push: { allocationHistory: { title: 'Returned to vault reserve', sub: `${auctionId} · ${b.reason}`, date: now } } },
          { session },
        );
        if (r.modifiedCount === 0) throw conflict('conflict/stale-state', `${a.lotId} is not back in the vault.`);
        result = { lotId: a.lotId };
        message = 'Lot returned to vault reserve';
      }
      const auditId = await recordAudit({ actor, category: 'vault', action: `Relisted auction lot (${b.action.replace('_', ' ')})`, record: { type: 'auction', id: auctionId, label: auctionId }, before: { status: a.status, outcome: a.outcome }, after: { ...result, action: b.action }, reason: b.action === 'vault_reserve' ? b.reason : undefined, req, session, activity: { text: message.replace(auctionId, auctionId), meta: a.lotId, kind: 'auction' } });
      return { result, message, auditId };
    });
    if (out.result.auctionId) await emitAuctionEvent(out.result.auctionId, 'state', { status: 'live', endsAt: null });
    res.json(action(out.result, out.message, out.auditId));
  }, { body: relistBody }),
];
