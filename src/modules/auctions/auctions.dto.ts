import { mobileMoney, webMoney } from '../../common/utils/currency.js';
import type { MoneyDoc } from '../../common/utils/currency.js';
import { mobileQuantity, webQuantity } from '../../common/utils/quantity.js';
import { agoDisplay, countdownDisplay, iso } from '../../common/utils/time-display.js';
import { now } from '../../common/utils/clock.js';
import type { IAuction, IBid } from '../../models/auction.model.js';
import { sameActorId } from './auction-ids.js';
import { ANTI_SNIPE, bidderInitials, bidderLabel, effectiveState, nextValidBidMinor, reserveMet } from './auction.rules.js';
import type { PlaceBidResult } from './auctions.service.js';

export type Viewer = {
  userId: string;
  best: Map<string, number>;
  autoBids: Map<string, number>;
  reminders: Set<string>;
} | null;

const m = (a: IAuction, amountMinor: number): MoneyDoc => ({ amountMinor, currency: a.currency });
const currentMinor = (a: IAuction) => a.highest?.amountMinor ?? a.startingBid.amountMinor;

/* ───────────────────────────── mobile ───────────────────────────── */

function mobileStatus(a: IAuction): 'live' | 'upcoming' | 'ended' {
  const st = effectiveState(a, now());
  if (st === 'upcoming') return 'upcoming';
  if (st === 'ended' || st === 'cancelled') return 'ended';
  return 'live';
}

export function toMobileAuctionSummary(a: IAuction) {
  const status = mobileStatus(a);
  const lotDisplay = `${mobileQuantity(a.quantityGrams).value} ${mobileQuantity(a.quantityGrams).unit}${a.grade ? ` · ${a.grade}` : ''}`;
  return {
    id: a._id,
    reference: a.reference,
    name: a.name,
    lot: { quantity: mobileQuantity(a.quantityGrams), grade: a.grade ?? null, display: lotDisplay },
    status,
    bid: mobileMoney(m(a, currentMinor(a))),
    bidLabel: status === 'upcoming' ? 'STARTING BID' : status === 'ended' ? 'SOLD FOR' : 'CURRENT BID',
    closesAt: a.closesAt.toISOString(),
    opensAt: a.opensAt.toISOString(),
    countdownDisplay: countdownDisplay(a.closesAt, now()),
    bidCount: a.bidCount,
    reserveMet: reserveMet(a),
    assured: a.assured,
    imageUrl: a.imageUrl ?? null,
  };
}

export function toMobileAuctionDetail(a: IAuction, viewer: Viewer) {
  const yourBid = viewer?.best.get(a._id);
  const status = mobileStatus(a);
  const youAreHighest = Boolean(viewer && sameActorId(a.highest?.bidderId, viewer.userId));
  // BUG-018: expose outcome so clients do not infer "won" from youAreHighest alone.
  const outcome =
    status === 'ended' && a.outcome
      ? {
          result: a.outcome.result,
          winnerId: a.outcome.winnerId ?? null,
          youWon: Boolean(viewer && a.outcome.result === 'sold' && sameActorId(a.outcome.winnerId, viewer.userId)),
        }
      : null;
  return {
    id: a._id,
    reference: a.reference,
    name: a.name,
    status,
    lot: {
      quantity: mobileQuantity(a.quantityGrams),
      grade: a.grade ?? null,
      display: `Lot ${a.reference} · ${mobileQuantity(a.quantityGrams).value} ${mobileQuantity(a.quantityGrams).unit}${a.grade ? ` · ${a.grade}` : ''}`,
    },
    description: a.description ?? null,
    badges: a.badges,
    sampling: a.sampling ? { by: a.sampling.by, at: iso(a.sampling.at), moisturePercent: a.sampling.moisturePercent ?? null } : null,
    bidding: {
      startingBid: mobileMoney(a.startingBid),
      highestBid: a.highest ? mobileMoney(m(a, a.highest.amountMinor)) : null,
      minimumIncrement: mobileMoney(a.minimumIncrement),
      nextValidBid: mobileMoney(m(a, nextValidBidMinor(a))),
      quickIncrements: a.quickIncrements,
      bidCount: a.bidCount,
      reserveMet: reserveMet(a),
      yourBid: yourBid !== undefined ? mobileMoney(m(a, yourBid)) : null,
      youAreHighest,
    },
    outcome,
    closesAt: a.closesAt.toISOString(),
    antiSniping: { enabled: ANTI_SNIPE.enabled, extendByMinutes: ANTI_SNIPE.extendByMs / 60_000, withinMinutes: ANTI_SNIPE.withinMs / 60_000 },
    bindingNote: 'Bids are binding. Winning bids move straight to delivery details.',
    imageUrl: a.imageUrl ?? null,
    mediaCount: a.mediaCount,
    version: a.version,
  };
}

export function toMobileBid(a: IAuction, b: IBid, viewerId: string | undefined) {
  return {
    id: b._id,
    bidderDisplayName: bidderLabel(a._id, b.bidderId),
    initials: bidderInitials(a._id, b.bidderId),
    amount: mobileMoney(m(a, b.amountMinor)),
    placedAt: b.placedAt.toISOString(),
    agoDisplay: agoDisplay(b.placedAt, now()),
    leading: a.highest?.bidId === b._id,
    isYou: viewerId === b.bidderId,
  };
}

export function toMobileBidPlaced(r: PlaceBidResult) {
  const mon = (n: number) => mobileMoney({ amountMinor: n, currency: r.auction.currency }, { display: false });
  return {
    bid: { id: r.bid.id, amount: mon(r.bid.amountMinor), placedAt: r.bid.placedAt, leading: r.bid.leading },
    auction: { highestBid: mon(r.auction.highestMinor), bidCount: r.auction.bidCount, closesAt: r.auction.closesAt, version: r.auction.version },
  };
}

export function toMobileMyBid(row: { auction: IAuction; yourBidMinor: number; status: string }) {
  const a = row.auction;
  return {
    auctionId: a._id,
    auctionName: a.name,
    imageUrl: a.imageUrl ?? null,
    yourBid: mobileMoney(m(a, row.yourBidMinor), { display: false }),
    highestBid: mobileMoney(m(a, currentMinor(a)), { display: false }),
    youAreHighest: row.status === 'leading' || row.status === 'won',
    status: row.status,
    closesAt: a.closesAt.toISOString(),
  };
}

export function toMobileResult(r: {
  auction: IAuction;
  outcome: string;
  yourLastBidMinor: number | null;
  winningMinor: number | null;
}) {
  const a = r.auction;
  const outcome = r.outcome === 'not_participated' ? 'lost' : r.outcome;
  const closedAt = a.outcome?.finalizedAt ?? a.closesAt;
  const winning = r.winningMinor ?? a.highest?.amountMinor ?? 0;
  return {
    auction: {
      id: a._id,
      reference: a.reference,
      name: a.name,
      lot: { display: `${mobileQuantity(a.quantityGrams).value} ${mobileQuantity(a.quantityGrams).unit}${a.grade ? ` · ${a.grade}` : ''}` },
      imageUrl: a.imageUrl ?? null,
    },
    outcome,
    closedAt: closedAt.toISOString(),
    closedAtDisplay: `${outcome === 'won' ? 'WON' : outcome === 'lost' ? 'LOST' : 'RESERVE NOT MET'} · ${closedAt.toISOString().slice(8, 10)} ${closedAt.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase()} ${closedAt.getUTCFullYear()}`,
    winningBid: mobileMoney(m(a, winning)),
    yourLastBid: r.yourLastBidMinor !== null ? mobileMoney(m(a, r.yourLastBidMinor)) : null,
    escrow: { held: outcome === 'won', note: 'Payment is held in escrow and released only after you confirm the delivered assay.' },
    nextAction:
      outcome === 'won'
        ? { kind: 'delivery_details', label: 'Proceed to delivery details' }
        : { kind: 'browse_similar', label: 'Browse similar lots' },
    similarLots: [] as unknown[],
  };
}

/* ───────────────────────────── web ───────────────────────────── */

export function toWebAuctionSummary(a: IAuction, viewer: Viewer) {
  const st = effectiveState(a, now());
  const state = st === 'upcoming' ? 'upcoming' : st === 'ended' || st === 'cancelled' ? 'ended' : 'live';
  const best = viewer?.best.get(a._id);
  const isHighest = Boolean(viewer && a.highest?.bidderId === viewer.userId);
  const ceiling = viewer?.autoBids.get(a._id);
  return {
    id: a._id,
    name: a.name,
    state,
    quantity: webQuantity(a.quantityGrams),
    grade: a.grade ?? '',
    origin: a.origin ?? '',
    currentBid: webMoney(m(a, currentMinor(a))),
    minimumIncrement: webMoney(a.minimumIncrement),
    bidCount: a.bidCount,
    opensAt: a.opensAt.toISOString(),
    closesAt: a.closesAt.toISOString(),
    serverTime: now().toISOString(),
    imageUrl: a.imageUrl ?? null,
    gradientFrom: a.gradientFrom ?? '#1f2937',
    gradientTo: a.gradientTo ?? '#92400e',
    viewer: viewer
      ? {
          highestBid: best !== undefined ? webMoney(m(a, best)) : null,
          isHighestBidder: isHighest,
          outbid: state === 'live' && best !== undefined && !isHighest,
          won: state === 'ended' && a.outcome?.result === 'sold' && a.outcome.winnerId === viewer.userId,
          autoBidCeiling: ceiling !== undefined ? webMoney(m(a, ceiling)) : null,
          reminderSet: viewer.reminders.has(a._id),
        }
      : null,
  };
}

export function toWebAuctionDetail(a: IAuction, viewer: Viewer) {
  const summary = toWebAuctionSummary(a, viewer);
  let result: unknown = null;
  if (summary.state === 'ended') {
    const best = viewer?.best.get(a._id);
    const sold = a.outcome?.result === 'sold';
    const won = Boolean(viewer && sold && a.outcome?.winnerId === viewer.userId);
    const outcome = !sold ? 'unsold' : won ? 'won' : best === undefined ? 'not_participated' : 'lost';
    result = {
      outcome,
      headline: outcome === 'won' ? 'You won this lot' : outcome === 'unsold' ? 'This lot did not sell' : outcome === 'lost' ? 'You did not win this lot' : 'Auction ended',
      detail: outcome === 'won' ? 'Track settlement in My Orders.' : outcome === 'unsold' ? 'The reserve was not met.' : 'Browse upcoming lots.',
      settlementOrderId: won ? (a.outcome?.settlementOrderId ?? null) : null,
    };
  }
  return {
    ...summary,
    lotId: a.productId ?? null,
    specs: a.specs,
    settlementTerms: a.settlementTerms,
    description: a.description ?? '',
    result,
  };
}

export function toWebBid(a: IAuction, b: IBid, viewerId: string | undefined) {
  return {
    id: b._id,
    bidderLabel: bidderLabel(a._id, b.bidderId),
    bidderInitials: bidderInitials(a._id, b.bidderId),
    isYou: viewerId === b.bidderId,
    amount: webMoney(m(a, b.amountMinor)),
    placedAt: b.placedAt.toISOString(),
    kind: b.kind,
  };
}

export function toWebBidPlaced(r: PlaceBidResult) {
  const mon = (n: number) => webMoney({ amountMinor: n, currency: r.auction.currency });
  return {
    bid: { id: r.bid.id, amount: mon(r.bid.amountMinor), placedAt: r.bid.placedAt },
    auction: { currentBid: mon(r.auction.highestMinor), bidCount: r.auction.bidCount, closesAt: r.auction.closesAt },
    isHighestBidder: r.isHighestBidder,
    minimumNextBid: mon(r.minimumNextMinor),
  };
}
