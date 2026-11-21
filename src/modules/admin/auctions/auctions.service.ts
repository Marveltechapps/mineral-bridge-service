import { EventEmitter } from 'node:events';
import type { ClientSession } from 'mongoose';
import { AppError, conflict, notFound } from '../../../common/errors/app-error.js';
import { nextId, nextSeq } from '../../../common/db/sequence.js';
import { withTx } from '../../../common/db/transaction.js';
import { logger } from '../../../config/logger.js';
import { Auction, AuctionEvent, Bid, Order, VaultLot } from '../../../models/trading.models.js';
import { recordAudit } from '../../audit/audit.service.js';
import { MS_HOUR } from '../shared/enums.js';
import { iso } from '../shared/http.js';
import { notifyStaff } from '../shared/notify.js';
import { sendCustomerMessage } from '../shared/messaging.js';
import { formatMoneyText, outMoney, outQty } from '../shared/money.js';
import { loadUserMap, partyFrom, type PartyRef } from '../shared/refs.js';
import { createSettlement } from '../settlements/settlements.service.js';

export const AUCTION_SORT: Record<string, string> = {
  id: 'auctionId',
  mineral: 'mineral.name',
  currentBid: 'currentBid.amountMinor',
  bids: 'bidCount',
  endsAt: 'endsAt',
  finalBid: 'finalBid.amountMinor',
};

export const MIN_DURATION_MS = MS_HOUR;
export const MAX_DURATION_MS = 14 * 24 * MS_HOUR;
export const OPEN_STATUSES = ['upcoming', 'live', 'paused'] as const;
export const EVENT_REPLAY_MS = 10 * 60_000;

export const auctionBus = new EventEmitter();
auctionBus.setMaxListeners(0);

export async function requireAuction(auctionId: string) {
  const a = await Auction.findOne({ auctionId }).lean();
  if (!a) throw notFound('resource/not-found', `Auction ${auctionId} not found`);
  return a;
}

export function staleAuction(a: Record<string, any>, verb: string) {  
  return conflict('conflict/stale-state', `${a.auctionId} is ${a.status} — cannot ${verb}.`, { details: { status: a.status } });
}

/** Persists an SSE event (replayable for 10 min, shared across instances) and wakes local streams. */
export async function emitAuctionEvent(auctionId: string, type: 'bid' | 'state' | 'risk', data: unknown, session?: ClientSession): Promise<number> {
  const seq = await nextSeq(`auction-event:${auctionId}`, session);
  await AuctionEvent.create([{ seq, auctionId, type, data, createdAt: new Date() }], { session });
  auctionBus.emit(auctionId);
  return seq;
}

export function bidDto(b: Record<string, any>, users: Map<string, PartyRef>, auction: Record<string, any>) {  
  return {
    id: b.bidId,
    amount: outMoney(b.amount),
    bidder: partyFrom(users, b.bidderId),
    at: iso(b.at),
    leading: Boolean(auction.currentBid && auction.leaderId === b.bidderId && auction.currentBid.amountMinor === b.amount.amountMinor),
    linkedAccount: Boolean(b.linkedAccount),
    meta: b.meta ?? '',
  };
}

export function auctionSummary(a: Record<string, any>, users: Map<string, PartyRef>) {  
  return {
    id: a.auctionId,
    status: a.status,
    mineral: a.mineral?.name,
    lotId: a.lotId,
    quantity: outQty(a.quantity),
    startingBid: outMoney(a.startingBid),
    reserve: outMoney(a.reserve),
    currentBid: outMoney(a.currentBid),
    bidCount: a.bidCount ?? 0,
    bidderCount: (a.bidderIds ?? []).length,
    leader: partyFrom(users, a.leaderId),
    opensAt: iso(a.opensAt),
    endsAt: iso(a.status === 'paused' && a.pausedAt ? a.endsAt : a.endsAt),
    access: a.access,
    flagged: Boolean(a.flagged),
    outcome: a.outcome ?? null,
    finalBid: outMoney(a.finalBid),
    winner: partyFrom(users, a.winnerId),
  };
}

export function auctionDetail(a: Record<string, any>, users: Map<string, PartyRef>) {  
  const reserveVsCost = a.reserve && a.costBasis?.amountMinor ? Number((((a.reserve.amountMinor - a.costBasis.amountMinor) / a.costBasis.amountMinor) * 100).toFixed(1)) : 0;
  return {
    ...auctionSummary(a, users),
    increment: outMoney(a.increment),
    costBasis: outMoney(a.costBasis),
    realisable: outMoney(a.realisable),
    reserveVsCostPct: reserveVsCost,
    pausedAt: iso(a.pausedAt),
    riskSignal: a.riskSignal?.kind ? { kind: a.riskSignal.kind, text: a.riskSignal.text, detectedAt: iso(a.riskSignal.detectedAt) } : null,
    ...(a.resolution?.closedAt
      ? {
          resolution: {
            closedAt: iso(a.resolution.closedAt),
            marginOverCostPct: a.resolution.marginOverCostPct ?? 0,
            buyOrderId: a.resolution.buyOrderId ?? null,
            ...(a.resolution.pipelineStage ? { pipelineStage: a.resolution.pipelineStage } : {}),
            escrowRef: a.resolution.escrowRef ?? null,
          },
        }
      : {}),
  };
}

export async function auctionDetailById(auctionId: string) {
  const a = await requireAuction(auctionId);
  return auctionDetail(a, await loadUserMap([a.leaderId, a.winnerId]));
}

/** SSE payload for the `state` event. */
export const stateEventData = (a: Record<string, any>) => ({ status: a.status, endsAt: iso(a.endsAt) });  

/**
 * Places a bid. Used by the customer-facing bid endpoints and exercised by the admin SSE tests.
 * The auction row is updated with an optimistic `bidCount` guard so two simultaneous bids cannot both lead.
 */
export async function recordBid(input: { auctionId: string; bidderId: string; amount: { amountMinor: number; currency: string; scale: number }; meta?: string }) {
  const a = await requireAuction(input.auctionId);
  const now = new Date();
  if (a.status !== 'live' || (a.endsAt && a.endsAt.getTime() <= now.getTime())) throw staleAuction(a, 'accept bids');
  if (input.amount.currency !== a.startingBid.currency) throw new AppError({ status: 422, code: 'rule/currency-mismatch', message: `Bids on ${a.auctionId} are in ${a.startingBid.currency}.` });
  const incMinor = a.increment?.amountMinor ?? 1;
  const minimum = a.currentBid ? a.currentBid.amountMinor + incMinor : a.startingBid.amountMinor;
  if (input.amount.amountMinor < minimum) {
    throw new AppError({ status: 422, code: 'rule/bid-too-low', message: `Minimum bid is ${formatMoneyText(outMoney({ ...a.startingBid, amountMinor: minimum }))}.`, details: { minimumMinor: minimum } });
  }
  const bidId = await nextId('bid');
  const first = !(a.bidderIds ?? []).includes(input.bidderId);
  const updated = await Auction.findOneAndUpdate(
    { auctionId: a.auctionId, status: 'live', bidCount: a.bidCount ?? 0 },
    { $set: { currentBid: input.amount, leaderId: input.bidderId }, $inc: { bidCount: 1 }, ...(first ? { $addToSet: { bidderIds: input.bidderId } } : {}) },
    { new: true },
  ).lean();
  if (!updated) throw conflict('conflict/stale-state', 'The auction moved while you were bidding — try again.');
  const bid = await Bid.create({ bidId, auctionId: a.auctionId, amount: input.amount, bidderId: input.bidderId, at: now, meta: input.meta ?? '' });
  const users = await loadUserMap([input.bidderId]);
  const dto = bidDto(bid.toObject(), users, updated);
  await emitAuctionEvent(a.auctionId, 'bid', {
    bid: dto,
    auction: { currentBid: outMoney(updated.currentBid), bidCount: updated.bidCount, leader: partyFrom(users, updated.leaderId), endsAt: iso(updated.endsAt) },
  });
  await detectVelocity(updated);
  return dto;
}

async function detectVelocity(a: Record<string, any>) {  
  if (a.riskSignal?.kind) return;
  const recent = await Bid.find({ auctionId: a.auctionId, at: { $gte: new Date(Date.now() - 60_000) } }).sort({ at: -1 }).limit(10).lean();
  if (recent.length < 5) return;
  const text = `${recent.length} bids in the last 60 s from ${new Set(recent.map((b) => b.bidderId)).size} account(s)`;
  const set = await Auction.updateOne({ auctionId: a.auctionId, 'riskSignal.kind': { $exists: false } }, { $set: { riskSignal: { kind: 'velocity', text, detectedAt: new Date() } } });
  if (set.modifiedCount === 0) return;
  await emitAuctionEvent(a.auctionId, 'risk', { kind: 'velocity', text, bidIds: recent.map((b) => b.bidId) });
  await notifyStaff({ module: 'auctions', text: `${a.auctionId}: unusual bid velocity`, meta: text, severity: 'medium', target: { type: 'auction', id: a.auctionId } });
}

/** upcoming → live when `opensAt` has passed. */
export async function activateDueAuctions(now = new Date()): Promise<number> {
  const due = await Auction.find({ status: 'upcoming', opensAt: { $lte: now } }).lean();
  let n = 0;
  for (const a of due) {
    const endsAt = new Date(now.getTime() + (a.durationMs ?? Math.max(MIN_DURATION_MS, a.endsAt.getTime() - a.opensAt.getTime())));
    const res = await Auction.findOneAndUpdate({ auctionId: a.auctionId, status: 'upcoming' }, { $set: { status: 'live', endsAt } }, { new: true }).lean();
    if (res) {
      n += 1;
      await emitAuctionEvent(a.auctionId, 'state', stateEventData(res));
    }
  }
  return n;
}

/**
 * Closes live auctions whose `endsAt` has passed. Reserve met → buy order at Verification for the winner
 * plus a pending auction settlement; otherwise the lot returns to the vault.
 */
export async function closeDueAuctions(now = new Date()): Promise<number> {
  const due = await Auction.find({ status: 'live', endsAt: { $lte: now } }).lean();
  let closed = 0;
  for (const a of due) {
    try {
      const done = await closeAuction(a.auctionId, now);
      if (done) closed += 1;
    } catch (err) {
      logger.error({ err, auctionId: a.auctionId }, 'Failed to close auction');
    }
  }
  return closed;
}

export async function closeAuction(auctionId: string, now = new Date()): Promise<boolean> {
  const result = await withTx(async (session) => {
    const a = await Auction.findOne({ auctionId, status: 'live' }, null, { session }).lean();
    if (!a || a.endsAt.getTime() > now.getTime()) return null;
    const met = Boolean(a.currentBid && a.leaderId && (!a.reserve || a.currentBid.amountMinor >= a.reserve.amountMinor));
    const set: Record<string, unknown> = { status: 'ended', outcome: met ? 'reserve_met' : 'reserve_not_met', 'resolution.closedAt': now };
    let orderId: string | undefined;
    if (met) {
      orderId = await nextId('orderBuy', session);
      const escrowRef = `ESC-${orderId}`;
      const lot = await VaultLot.findOne({ lotId: a.lotId }, null, { session }).lean();
      Object.assign(set, {
        finalBid: a.currentBid,
        winnerId: a.leaderId,
        'resolution.buyOrderId': orderId,
        'resolution.pipelineStage': 'verification',
        'resolution.escrowRef': escrowRef,
        'resolution.marginOverCostPct': a.costBasis?.amountMinor ? Number((((a.currentBid.amountMinor - a.costBasis.amountMinor) / a.costBasis.amountMinor) * 100).toFixed(1)) : 0,
      });
      await Order.create(
        [
          {
            orderId,
            side: 'buy',
            status: 'active',
            mineral: a.mineral,
            grade: a.grade,
            counterpartyId: a.leaderId,
            quantity: a.quantity,
            stage: 'verification',
            stageEnteredAt: now,
            openedAt: now,
            value: a.currentBid,
            escrowRef,
            origin: 'Mineral Bridge vault',
            destination: 'Buyer',
            lotId: a.lotId,
            auctionId: a.auctionId,
            stageLog: [{ stage: 'verification', at: now, description: `Won at auction ${a.auctionId}` }],
            history: [{ text: `Order created from auction ${a.auctionId}`, at: now }],
            createdBy: 'system',
          },
        ],
        { session },
      );
      await createSettlement({ kind: 'auction_settlement', ref: { type: 'auction', id: a.auctionId }, partyId: a.leaderId, amount: a.currentBid, status: 'pending', escrowRef, session });
      if (lot) await VaultLot.updateOne({ lotId: a.lotId }, { $set: { status: 'reserved' }, $unset: { auctionId: 1 }, $push: { allocationHistory: { title: 'Sold at auction', sub: `${a.auctionId} → ${orderId}`, date: now, amount: a.currentBid } } }, { session });
    } else {
      await VaultLot.updateOne({ lotId: a.lotId }, { $set: { status: 'in_vault' }, $unset: { auctionId: 1 }, $push: { allocationHistory: { title: 'Auction closed — reserve not met', sub: a.auctionId, date: now } } }, { session });
    }
    const updated = await Auction.findOneAndUpdate({ auctionId, status: 'live' }, { $set: set }, { new: true, session }).lean();
    if (!updated) return null;
    await recordAudit({
      actor: null,
      category: 'orders',
      action: met ? 'Auction closed — reserve met' : 'Auction closed — reserve not met',
      record: { type: 'auction', id: auctionId, label: auctionId },
      after: { outcome: set.outcome, finalBid: met ? outMoney(a.currentBid) : null, buyOrderId: orderId },
      session,
      activity: { text: met ? `Auction ${auctionId} closed — reserve met` : `Auction ${auctionId} closed — reserve not met`, meta: met ? `Buy order ${orderId} opened` : 'Lot returned to the vault', kind: 'auction', ref: { type: 'auction', id: auctionId } },
    });
    return { updated, met, orderId };
  });
  if (!result) return false;
  await emitAuctionEvent(auctionId, 'state', stateEventData(result.updated));
  await notifyStaff({ module: 'auctions', text: `${auctionId} closed — ${result.met ? 'reserve met' : 'reserve not met'}`, target: { type: 'auction', id: auctionId } }).catch(() => undefined);
  if (result.met && result.updated.winnerId) {
    await sendCustomerMessage({ userId: result.updated.winnerId, subject: `You won ${auctionId}`, body: `Your winning bid of ${formatMoneyText(outMoney(result.updated.finalBid))} is confirmed. Order ${result.orderId} has been opened.`, channels: ['in_app'], related: { type: 'order', id: result.orderId! }, sentBy: 'system' }).catch(() => undefined);
  }
  return true;
}

let timer: NodeJS.Timeout | undefined;
export function startAuctionScheduler(intervalMs = 5_000): () => void {
  if (timer) return () => undefined;
  timer = setInterval(() => {
    void activateDueAuctions().then(() => closeDueAuctions()).catch((err) => logger.error({ err }, 'Auction scheduler tick failed'));
  }, intervalMs);
  timer.unref();
  return () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
}

