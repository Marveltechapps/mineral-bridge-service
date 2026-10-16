import { mobileMoney, webMoney } from '../common/utils/currency.js';
import type { HubEvent } from './auction-hub.js';
import type { WsChannelKind, WsClient } from './ws-auth.js';

type Data = Record<string, unknown>;
type Frame = Record<string, unknown>;

const money = (client: WsClient, amountMinor: unknown, currency: unknown) => {
  const doc = { amountMinor: Number(amountMinor), currency: String(currency ?? 'USD') };
  return client === 'mobile' ? mobileMoney(doc, { display: true }) : webMoney(doc);
};

const SELL_PROGRESS: Record<string, number> = {
  submitted: 10, evaluation_scheduled: 25, evaluating: 50, assaying: 65, offer_ready: 80, accepted: 90, paid: 100, declined: 100, cancelled: 100, expired: 100,
};

/** Wire envelopes. Mobile: `{ event, at, data }` (§8.1). Web: `{ event, sequence, sentAt, data }` (§24). */
function envelope(client: WsClient, e: HubEvent, event: string, data: unknown): Frame {
  return client === 'mobile' ? { event, at: e.at, data } : { event, sequence: e.seq, sentAt: e.at, data };
}

/**
 * Maps one domain hub event to zero or more client frames. Domain events carry minor-unit integers and
 * ids only; this is the single place where they become each client's contract shape.
 * Returns `[]` when the event is not part of that client's contract (it is simply not delivered).
 */
export function mapEvent(kind: WsChannelKind, client: WsClient, viewerId: string, e: HubEvent): Frame[] {
  const d = e.data as Data;
  const out = (event: string, data: unknown) => [envelope(client, e, event, data)];

  if (kind === 'auction') {
    switch (e.event) {
      case 'bid.placed':
        return client === 'mobile'
          ? out('bid.placed', {
              bid: { id: d.bidId, bidderLabel: d.bidderLabel, amount: money(client, d.amountMinor, d.currency), placedAt: d.placedAt, isYours: d.bidderId === viewerId },
              highestBid: money(client, d.highestMinor, d.currency),
              bidCount: d.bidCount,
              reserveMet: d.reserveMet,
              version: d.version,
            })
          : out('bid.placed', {
              bidId: d.bidId,
              amount: money(client, d.amountMinor, d.currency),
              bidderLabel: d.bidderLabel,
              placedAt: d.placedAt,
              bidCount: d.bidCount,
              minimumNextBid: money(client, d.minimumNextMinor, d.currency),
            });
      case 'bidder.outbid':
        return client === 'mobile'
          ? out('bidder.outbid', { auctionId: d.auctionId, auctionName: d.auctionName, newHighestBid: money(client, d.newHighestMinor, d.currency), closesAt: d.closesAt, yourBid: money(client, d.yourBidMinor, d.currency) })
          : out('bidder.outbid', { yourBid: money(client, d.yourBidMinor, d.currency), currentBid: money(client, d.newHighestMinor, d.currency), auctionName: d.auctionName });
      case 'auction.extended':
        return out('auction.extended', { closesAt: d.closesAt, reason: client === 'mobile' ? 'anti_sniping' : 'anti_snipe' });
      case 'auction.closing':
        return client === 'web' ? out('auction.closing', { secondsRemaining: d.secondsRemaining }) : [];
      case 'auction.closed': {
        const won = d.winnerId === viewerId;
        const winning = d.winningMinor == null ? null : money(client, d.winningMinor, d.currency);
        if (client === 'mobile') {
          const outcome = d.result === 'sold' ? (won ? 'won' : 'lost') : 'reserve_not_met';
          return out('auction.closed', { outcome, winningBid: winning, yourBid: won ? winning : null });
        }
        const outcome = d.result === 'sold' ? (won ? 'won' : 'lost') : 'unsold';
        return out('auction.closed', { finalBid: winning, outcome, settlementOrderId: won ? d.settlementOrderId ?? null : null });
      }
      default:
        return [];
    }
  }

  if (kind === 'sell-request' && client === 'mobile') {
    if (e.event !== 'request.updated') return [];
    const frames: Frame[] = [];
    const status = String(d.status);
    frames.push(envelope(client, e, 'stage.advanced', { stage: d.timeline ?? { key: status }, progress: SELL_PROGRESS[status] ?? 0, eta: null }));
    if (status === 'evaluating' && d.evaluator) frames.push(envelope(client, e, 'evaluator.assigned', { evaluator: d.evaluator }));
    const offer = d.offer as { id: string; amountMinor: number; currency: string; expiresAt: string } | null;
    if (status === 'offer_ready' && offer) frames.push(envelope(client, e, 'offer.issued', { offerId: offer.id, amount: money(client, offer.amountMinor, offer.currency), expiresAt: offer.expiresAt }));
    return frames;
  }

  if (kind === 'chat' && client === 'mobile') {
    switch (e.event) {
      case 'message.created': {
        const m = d.message as Data;
        return out('message.received', { message: m });
      }
      case 'agent.joined':
      case 'agent.typing':
      case 'message.read':
        return out(e.event, d);
      case 'session.ended':
        return out('session.ended', { endedBy: d.endedBy, transcriptEmailedTo: d.transcriptEmailedTo ?? null });
      default:
        return [];
    }
  }

  if (kind === 'negotiation' && client === 'web') {
    const rel = (authorId: unknown) => (authorId === viewerId ? 'me' : 'counterparty');
    switch (e.event) {
      case 'message.created': {
        const m = d.message as Data;
        return out('message.created', { id: m._id, kind: m.kind, author: m.authorId ? rel(m.authorId) : 'system', body: m.body ?? null, offerId: m.offerId ?? null, event: m.event ?? null, createdAt: m.createdAt });
      }
      case 'offer.created':
        return out('offer.created', { offerId: d.offerId, author: rel(d.authorId), supersededOfferId: d.supersededOfferId ?? null, status: d.status });
      case 'offer.countered':
        return out('offer.countered', { counteredOfferId: d.counteredOfferId, newOfferId: d.offerId, author: rel(d.authorId), status: d.status });
      case 'offer.accepted':
        return out('offer.accepted', { offerId: d.offerId, agreedOfferId: d.agreedOfferId, contractId: d.contractId ?? null });
      case 'offer.rejected':
        return out('offer.rejected', { offerId: d.offerId, status: d.status });
      case 'status.changed':
        return out('status.changed', { status: d.status, reason: d.reason ?? null });
      case 'typing':
        return d.from === viewerId ? [] : out('typing', { party: 'them' });
      default:
        return [];
    }
  }

  return [];
}
