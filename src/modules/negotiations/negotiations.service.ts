import { conflict, forbidden, notFound, unprocessable } from '../../common/errors/app-error.js';
import { idempotencyScope, runIdempotent } from '../../common/idempotency/idempotency.js';
import { addMs, now } from '../../common/utils/clock.js';
import { opaqueId } from '../../common/utils/ids.js';
import { references } from '../../common/utils/references.js';
import { channels, realtimeHub } from '../../realtime/auction-hub.js';
import { ProductModel } from '../../models/catalog.model.js';
import type { IProduct } from '../../models/catalog.model.js';
import { NegotiationMessageModel, NegotiationModel } from '../../models/web-trade.model.js';
import type { INegotiation, INegotiationMessage, INegotiationOffer, OfferState } from '../../models/web-trade.model.js';
import { notifyUser } from '../notifications/notifications.service.js';

/** The desk acts as seller for platform inventory (lots without an owning customer). */
export const PLATFORM_SELLER_ID = 'mineral_bridge';
export const OFFER_TTL_MS = 72 * 3600 * 1000;
const MAX_OFFERS = 50;

export type OfferInput = {
  price: { amountMinor: number; currency: string };
  unit: string;
  quantity: number;
  incoterm: string;
  namedPort: string;
  shipmentFrom: string;
  shipmentTo: string;
};

const LIVE = ['awaiting_reply', 'offer_received'] as const;

export const isParty = (n: Pick<INegotiation, 'buyerId' | 'sellerId'>, userId: string) => n.buyerId === userId || n.sellerId === userId;
export const counterpartOf = (n: Pick<INegotiation, 'buyerId' | 'sellerId'>, userId: string) => (n.buyerId === userId ? n.sellerId : n.buyerId);
export const openOffer = (n: Pick<INegotiation, 'offers'>): INegotiationOffer | undefined => n.offers.find((o) => o.state === 'open');

/** Status as seen by one participant: an open offer authored by the other side is "offer_received". */
export function statusFor(n: INegotiation, userId: string): INegotiation['status'] {
  if (n.status === 'agreed' || n.status === 'closed') return n.status;
  const o = openOffer(n);
  if (!o) return n.status;
  return o.authorId === userId ? 'awaiting_reply' : 'offer_received';
}

function buildOffer(authorId: string, input: OfferInput, inResponseTo?: string): INegotiationOffer {
  if (!Number.isSafeInteger(input.price.amountMinor) || input.price.amountMinor <= 0) throw unprocessable('Price must be a positive integer in minor units', { price: 'Invalid price' });
  const total = Math.round(input.price.amountMinor * input.quantity);
  if (!Number.isSafeInteger(total)) throw unprocessable('Offer total is out of range', { quantity: 'Too large' });
  return {
    _id: opaqueId('off'),
    authorId,
    price: input.price,
    unit: input.unit,
    quantity: input.quantity,
    incoterm: input.incoterm,
    namedPort: input.namedPort,
    shipmentFrom: input.shipmentFrom,
    shipmentTo: input.shipmentTo,
    total: { amountMinor: total, currency: input.price.currency },
    state: 'open',
    inResponseTo,
    expiresAt: addMs(now(), OFFER_TTL_MS),
    createdAt: now(),
  };
}

async function postMessage(n: INegotiation, m: Omit<INegotiationMessage, '_id' | 'negotiationId' | 'createdAt'>) {
  const doc = await NegotiationMessageModel.create({ _id: opaqueId('nmg'), negotiationId: n._id, ...m });
  const msg = doc.toObject() as INegotiationMessage;
  realtimeHub.publish(channels.negotiation(n._id), 'message.created', { negotiationId: n._id, message: msg });
  return msg;
}

export const negotiationsService = {
  async start(buyerId: string, input: { lotId: string; offer: OfferInput; message?: string; idempotencyKey: string }) {
    const out = await runIdempotent<{ id: string }>({
      scope: idempotencyScope(buyerId, 'negotiation:start'),
      key: input.idempotencyKey,
      body: { lotId: input.lotId, offer: input.offer, message: input.message },
      successStatus: 201,
      fn: async () => ({ id: await this.startOnce(buyerId, input) }),
    });
    return { id: out.result.id, replayed: out.replayed };
  },

  async startOnce(buyerId: string, input: { lotId: string; offer: OfferInput; message?: string }): Promise<string> {
    const lot = await ProductModel.findById(input.lotId).lean<IProduct>();
    if (!lot || lot.status !== 'active') throw notFound('lot/not-found', 'Lot not found or no longer available');
    const sellerId = lot.sellerId ?? PLATFORM_SELLER_ID;
    if (sellerId === buyerId) throw conflict('negotiation/own-lot', 'You cannot negotiate on your own lot.');
    const offer = buildOffer(buyerId, input.offer);
    try {
      const doc = await NegotiationModel.create({
        reference: await references.negotiation(),
        lotId: lot._id,
        lotName: lot.name,
        lotSummary: lot.description ?? '',
        lotGrade: lot.grade ?? lot.purity ?? '',
        buyerId,
        sellerId,
        status: 'awaiting_reply',
        offers: [offer],
        lastOfferAuthorId: buyerId,
        openKey: `${lot._id}:${buyerId}`,
        lastMessageAt: now(),
        lastMessagePreview: 'Offer sent',
        unread: { [sellerId]: 1 },
        version: 0,
      });
      const n = doc.toObject() as INegotiation;
      await postMessage(n, { kind: 'offer', authorId: buyerId, offerId: offer._id });
      if (input.message) await postMessage(n, { kind: 'text', authorId: buyerId, body: input.message });
      if (sellerId !== PLATFORM_SELLER_ID) await notifyUser(sellerId, { event: 'negotiation.offer', title: `New offer on ${lot.name}`, target: { type: 'negotiation', id: n._id } });
      return n._id;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw conflict('negotiation/already-open', 'You already have a live negotiation on this lot.');
      throw err;
    }
  },

  async load(userId: string, id: string): Promise<INegotiation> {
    const n = await NegotiationModel.findById(id).lean<INegotiation>();
    if (!n || !isParty(n, userId)) throw notFound('negotiation/not-found', 'Negotiation not found');
    return this.expireIfDue(n);
  },

  /** Lazy expiry: an open offer past its deadline becomes `expired` and closes the negotiation. */
  async expireIfDue(n: INegotiation): Promise<INegotiation> {
    const o = openOffer(n);
    if (!o || !o.expiresAt || o.expiresAt.getTime() > now().getTime()) return n;
    const offers = n.offers.map((x) => (x._id === o._id ? { ...x, state: 'expired' as OfferState } : x));
    const updated = await NegotiationModel.findOneAndUpdate(
      { _id: n._id, version: n.version },
      { $set: { offers, status: 'closed' }, $unset: { openKey: 1 }, $inc: { version: 1 } },
      { new: true },
    ).lean<INegotiation>();
    if (updated) realtimeHub.publish(channels.negotiation(n._id), 'status.changed', { negotiationId: n._id, status: 'closed', reason: 'expired' });
    return updated ?? (await NegotiationModel.findById(n._id).lean<INegotiation>()) ?? n;
  },

  async list(userId: string, status: INegotiation['status'] | undefined, skip: number, limit: number) {
    const filter = { $or: [{ buyerId: userId }, { sellerId: userId }] };
    const [rows, total] = await Promise.all([
      NegotiationModel.find(filter).sort({ updatedAt: -1, _id: -1 }).skip(skip).limit(limit).lean<INegotiation[]>(),
      NegotiationModel.countDocuments(filter),
    ]);
    const resolved = await Promise.all(rows.map((n) => this.expireIfDue(n)));
    const filtered = status ? resolved.filter((n) => statusFor(n, userId) === status) : resolved;
    return { rows: filtered, total };
  },

  async messages(userId: string, id: string, limit = 100) {
    const n = await this.load(userId, id);
    const rows = await NegotiationMessageModel.find({ negotiationId: n._id }).sort({ createdAt: -1, _id: -1 }).limit(limit).lean<INegotiationMessage[]>();
    return rows.reverse();
  },

  /**
   * Atomic offer-chain rewrite. `mutate` returns the new offers array and negotiation fields; the write is
   * a compare-and-set on `version`, so two concurrent responses cannot both win (invariant: <= 1 open offer).
   */
  async rewrite(n: INegotiation, userId: string, offers: INegotiationOffer[], fields: Record<string, unknown>, unsetOpenKey: boolean, kind: 'created' | 'accepted' | 'countered' | 'rejected', offerId: string, extra: Record<string, unknown> = {}) {
    if (offers.filter((o) => o.state === 'open').length > 1) throw conflict('negotiation/multiple-open-offers', 'Only one open offer is allowed.');
    if (offers.length > MAX_OFFERS) throw conflict('negotiation/too-many-offers', 'This negotiation has too many offers; please contact support.');
    const update: Record<string, unknown> = { $set: { offers, ...fields }, $inc: { version: 1 } };
    if (unsetOpenKey) update.$unset = { openKey: 1 };
    const updated = await NegotiationModel.findOneAndUpdate({ _id: n._id, version: n.version, status: { $in: LIVE } }, update, { new: true }).lean<INegotiation>();
    if (!updated) {
      const cur = await NegotiationModel.findById(n._id).lean<INegotiation>();
      throw conflict('negotiation/state-changed', 'The negotiation changed. Refresh and try again.', { current: { status: cur?.status, offerState: cur ? openOffer(cur)?._id ?? null : null } } as never);
    }
    const other = counterpartOf(n, userId);
    realtimeHub.publish(channels.negotiation(n._id), `offer.${kind}`, { negotiationId: n._id, offerId, authorId: userId, status: updated.status, contractId: updated.contractId ?? null, offers: updated.offers.map((o) => ({ id: o._id, state: o.state })), ...extra });
    if (other !== PLATFORM_SELLER_ID) await notifyUser(other, { event: 'negotiation.offer', title: `Update on ${n.lotName}`, target: { type: 'negotiation', id: n._id } });
    return updated;
  },

  requireLive(n: INegotiation) {
    if (n.status === 'agreed') throw conflict('negotiation/already-agreed', 'This negotiation has already been agreed.');
    if (n.status === 'closed') throw conflict('negotiation/closed', 'This negotiation is closed.');
  },

  /** New offer by a participant. Their own open offer is superseded; the other side's is countered. */
  async submitOffer(userId: string, id: string, input: OfferInput, inResponseTo?: string) {
    const n = await this.load(userId, id);
    this.requireLive(n);
    const cur = openOffer(n);
    if (inResponseTo && cur?._id !== inResponseTo) throw conflict('negotiation/offer-not-open', 'That offer is no longer open.');
    const next = buildOffer(userId, input, cur && cur.authorId !== userId ? cur._id : undefined);
    const offers = n.offers.map((o) => (o.state === 'open' ? { ...o, state: (o.authorId === userId ? 'superseded' : 'countered') as OfferState } : o)).concat(next);
    const updated = await this.rewrite(n, userId, offers, { status: 'awaiting_reply', lastOfferAuthorId: userId, lastMessageAt: now(), lastMessagePreview: 'New offer', [`unread.${counterpartOf(n, userId)}`]: (n.unread[counterpartOf(n, userId)] ?? 0) + 1 }, false, cur && cur.authorId !== userId ? 'countered' : 'created', next._id, cur ? (cur.authorId === userId ? { supersededOfferId: cur._id } : { counteredOfferId: cur._id }) : {});
    await postMessage(updated, { kind: 'offer', authorId: userId, offerId: next._id });
    return updated;
  },

  async accept(userId: string, id: string, offerId: string) {
    const n = await this.load(userId, id);
    this.requireLive(n);
    const o = n.offers.find((x) => x._id === offerId);
    if (!o || o.state !== 'open') throw conflict('negotiation/offer-not-open', 'That offer is no longer open.');
    if (o.authorId === userId) throw forbidden('negotiation/own-offer', 'You cannot accept your own offer.');
    const offers = n.offers.map((x) => (x._id === offerId ? { ...x, state: 'accepted' as OfferState } : x));
    const updated = await this.rewrite(n, userId, offers, { status: 'agreed', agreedOfferId: offerId, lastMessageAt: now(), lastMessagePreview: 'Offer accepted' }, true, 'accepted', offerId, { agreedOfferId: offerId });
    await postMessage(updated, { kind: 'system', event: 'offer.accepted', offerId });
    return updated;
  },

  async reject(userId: string, id: string, offerId: string) {
    const n = await this.load(userId, id);
    this.requireLive(n);
    const o = n.offers.find((x) => x._id === offerId);
    if (!o || o.state !== 'open') throw conflict('negotiation/offer-not-open', 'That offer is no longer open.');
    if (o.authorId === userId) throw forbidden('negotiation/own-offer', 'Use a new offer to replace your own; you cannot reject it.');
    const offers = n.offers.map((x) => (x._id === offerId ? { ...x, state: 'rejected' as OfferState } : x));
    const updated = await this.rewrite(n, userId, offers, { status: 'closed', lastMessageAt: now(), lastMessagePreview: 'Offer declined' }, true, 'rejected', offerId);
    await postMessage(updated, { kind: 'system', event: 'offer.rejected', offerId });
    return updated;
  },

  async sendMessage(userId: string, id: string, body: string) {
    const n = await this.load(userId, id);
    if (n.status === 'closed') throw conflict('negotiation/closed', 'This negotiation is closed.');
    const other = counterpartOf(n, userId);
    await NegotiationModel.updateOne({ _id: id }, { $set: { lastMessageAt: now(), lastMessagePreview: body.slice(0, 120) }, $inc: { [`unread.${other}`]: 1 } });
    return postMessage(n, { kind: 'text', authorId: userId, body });
  },

  async markRead(userId: string, id: string) {
    const n = await this.load(userId, id);
    await NegotiationModel.updateOne({ _id: id }, { $set: { [`unread.${userId}`]: 0 } });
    return n;
  },
};
