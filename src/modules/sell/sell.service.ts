import type { FilterQuery } from 'mongoose';
import { conflict, forbidden, gone, notFound, unprocessable } from '../../common/errors/app-error.js';
import { idempotencyScope, runIdempotent } from '../../common/idempotency/idempotency.js';
import { addMs, HOUR_MS, MINUTE_MS, now } from '../../common/utils/clock.js';
import { feeMinor, FEES, totalMinor } from '../../common/utils/pricing-math.js';
import { references } from '../../common/utils/references.js';
import { StateMachine } from '../../common/utils/state-machine.js';
import { opaqueId } from '../../common/utils/ids.js';
import { MineralTypeModel } from '../../models/catalog.model.js';
import type { IMineralType } from '../../models/catalog.model.js';
import { BulkQuoteModel, EstimateModel, SellDocumentModel, SellRequestModel } from '../../models/sell.model.js';
import type { IBulkQuote, IEstimate, ISellDocument, ISellOffer, ISellRequest, SellStatus } from '../../models/sell.model.js';
import { SupportTicketModel } from '../../models/support.model.js';
import { UserModel } from '../../models/user.model.js';
import type { IAddress } from '../../models/user.model.js';
import { REFERENCE_DEFAULTS } from '../content/defaults.js';
import { contentService } from '../content/content.service.js';
import { channels, realtimeHub } from '../../realtime/auction-hub.js';
import { notifyUser } from '../notifications/notifications.service.js';
import { payoutsService, walletService } from '../payouts/payouts.service.js';
import { uploadsService } from '../uploads/uploads.service.js';

export const sellMachine = new StateMachine<SellStatus>(
  'sell-request',
  {
    booked: ['evaluating', 'cancelled', 'expired'],
    evaluating: ['offer_ready', 'cancelled'],
    offer_ready: ['sold', 'declined', 'expired', 'evaluating'],
    sold: [],
    declined: [],
    expired: [],
    cancelled: [],
  },
  'sell/invalid-transition',
);

const ASSUMED_PURITY_PCT = 85;
const ESTIMATE_TTL_MS = 15 * MINUTE_MS;
const OFFER_VALIDITY_HOURS = 48;
const SLOT_HOURS = [9, 11, 14, 16];
const WAT_OFFSET_H = 1;
const CODE_BY_SLUG: Record<string, string> = { gold: 'AU', silver: 'AG', platinum: 'PT', copper: 'CU', lithium: 'LI', cobalt: 'CO', diamond: 'DIA' };

export type CreateSellInput = {
  userId: string;
  tier: number;
  mineralTypeId: string;
  grams: number;
  photoIds: string[];
  estimateId?: string;
  pickup: { addressId?: string; label?: string; display?: string };
  slotKey: string;
  payoutAccountId?: string;
  idempotencyKey: string;
};
type MineralInfo = { id: string; slug: string; name: string; mineralCode: string; tiers: number[] };

/* -- helpers ----------------------------------------------------------------------------- */

/** Fan a sell-request change out to `/v1/ws/sell-requests/{id}` subscribers (domain event; mapped per client). */
function publishSell(r: ISellRequest): ISellRequest {
  realtimeHub.publish(channels.sellRequest(r._id), 'request.updated', {
    requestId: r._id,
    userId: r.userId,
    status: r.status,
    version: r.version,
    offerStatus: r.offer?.status ?? null,
    offerVersion: r.offer?.version ?? null,
    offer: r.offer ? { id: r.offer._id, amountMinor: r.offer.amount.amountMinor, currency: r.offer.amount.currency, expiresAt: r.offer.expiresAt.toISOString() } : null,
    evaluator: r.evaluator ? { id: r.evaluator.id, name: r.evaluator.name, subtitle: r.evaluator.subtitle ?? null } : null,
    timeline: r.timeline?.[r.timeline.length - 1] ?? null,
  });
  return r;
}
async function mineralTypes(): Promise<MineralInfo[]> {
  const rows = await MineralTypeModel.find({ active: true, sellable: true }).sort({ sort: 1, name: 1 }).lean<IMineralType[]>();
  if (rows.length) return rows.map((t) => ({ id: t._id, slug: t.slug, name: t.name, mineralCode: t.mineralCode ?? CODE_BY_SLUG[t.slug] ?? t.slug.toUpperCase(), tiers: t.tiers }));
  return REFERENCE_DEFAULTS.mineral.map((m) => ({ id: `default-${m.code}`, slug: m.code.toLowerCase(), name: m.name, mineralCode: m.code, tiers: [1, 2, 3] }));
}

async function resolveMineral(id: string): Promise<MineralInfo> {
  const found = (await mineralTypes()).find((m) => m.id === id);
  if (!found) throw unprocessable('Unknown mineral type', { mineralTypeId: 'Unknown' }, 'sell/unknown-mineral');
  return found;
}

async function deskRateE4(mineralCode: string): Promise<{ e4: number; asOf: Date }> {
  const rate = (await contentService.rates()).find((r) => r.mineralCode === mineralCode);
  if (!rate) throw unprocessable('No desk rate is published for this mineral', { mineralTypeId: 'No rate' }, 'sell/no-rate');
  return { e4: rate.unitPriceMinorE4PerGram, asOf: rate.asOf };
}

const slotAt = (key: string) => new Date(`${key}:00+0${WAT_OFFSET_H}:00`);

function band(grams: number, e4: number, purityPct: number, deductionBps: number) {
  const mid = totalMinor(Math.round((grams * purityPct) / 100), e4);
  const net = (m: number) => m - feeMinor(m, deductionBps);
  return { low: net(Math.round(mid * 0.92)), high: net(Math.round(mid * 1.05)), midpoint: net(mid) };
}

const pushTimeline = (key: string, sub?: string) => ({ key, at: now(), ...(sub ? { sub } : {}) });

/* -- service ----------------------------------------------------------------------------- */

export const sellService = {
  mineralTypes,

  async estimate(userId: string, input: { mineralTypeId: string; grams: number; photoIds?: string[] }): Promise<IEstimate> {
    const m = await resolveMineral(input.mineralTypeId);
    if (input.photoIds?.length) await uploadsService.ownedMany(userId, input.photoIds);
    const user = await UserModel.findById(userId).lean();
    if (user && !m.tiers.includes(user.tier)) throw forbidden('sell/tier-not-allowed', 'This mineral is not available for your account tier');
    const { e4, asOf } = await deskRateE4(m.mineralCode);
    const b = band(input.grams, e4, ASSUMED_PURITY_PCT, FEES.webSellPlatformBps);
    const doc = await EstimateModel.create({
      userId,
      mineralTypeId: m.id,
      mineralName: m.name,
      grams: input.grams,
      photoIds: input.photoIds ?? [],
      assumedPurityPct: ASSUMED_PURITY_PCT,
      low: { amountMinor: b.low, currency: 'USD' },
      high: { amountMinor: b.high, currency: 'USD' },
      midpoint: { amountMinor: b.midpoint, currency: 'USD' },
      rateUnitMinorE4PerGram: e4,
      rateAsOf: asOf,
      deductionBps: FEES.webSellPlatformBps,
      expiresAt: addMs(now(), ESTIMATE_TTL_MS),
    });
    return doc.toObject() as IEstimate;
  },

  async slots(fromDay: string | undefined, days: number) {
    const start = fromDay ? new Date(`${fromDay}T00:00:00+0${WAT_OFFSET_H}:00`) : addMs(now(), 24 * HOUR_MS);
    const out: { key: string; at: Date }[] = [];
    for (let d = 0; out.length < days * SLOT_HOURS.length && d < days + 7; d++) {
      const day = new Date(start.getTime() + d * 24 * HOUR_MS);
      const wat = new Date(day.getTime() + WAT_OFFSET_H * HOUR_MS);
      if (wat.getUTCDay() === 0) continue; // no Sunday evaluations
      const ymd = wat.toISOString().slice(0, 10);
      for (const h of SLOT_HOURS) {
        const key = `${ymd}T${String(h).padStart(2, '0')}:00`;
        if (slotAt(key) > now()) out.push({ key, at: slotAt(key) });
      }
      if (new Set(out.map((s) => s.key.slice(0, 10))).size >= days) break;
    }
    const taken = new Set(await SellRequestModel.distinct('activeSlotKey', { activeSlotKey: { $in: out.map((s) => s.key) } }));
    return out.map((s) => ({ ...s, available: !taken.has(s.key) }));
  },

  async create(input: CreateSellInput) {
    const out = await runIdempotent<{ requestId: string }>({
      scope: idempotencyScope(input.userId, 'sell:create'),
      key: input.idempotencyKey,
      body: { ...input, idempotencyKey: undefined },
      successStatus: 201,
      fn: async () => ({ requestId: await this.createOnce(input) }),
    });
    return { requestId: out.result.requestId, replayed: out.replayed };
  },

  async createOnce(input: CreateSellInput): Promise<string> {
    const m = await resolveMineral(input.mineralTypeId);
    if (!m.tiers.includes(input.tier)) throw forbidden('sell/tier-not-allowed', 'This mineral is not available for your account tier');
    if (input.photoIds.length) await uploadsService.ownedMany(input.userId, input.photoIds);
    const valid = (await this.slots(input.slotKey.slice(0, 10), 1)).find((s) => s.key === input.slotKey);
    if (!valid) throw unprocessable('That evaluation slot is not available', { 'evaluation.slotKey': 'Unavailable slot' }, 'sell/slot-invalid');
    if (!valid.available) throw conflict('sell/slot-taken', 'That evaluation slot was just taken. Pick another.');

    let pickup = input.pickup;
    if (pickup.addressId) {
      const u = await UserModel.findById(input.userId).lean();
      const a: IAddress | undefined = u?.addresses.find((x) => x.id === pickup.addressId);
      if (!a) throw unprocessable('Pickup address not found', { 'pickup.addressId': 'Unknown address' });
      pickup = { addressId: a.id, label: a.label, display: `${a.streetAddress}, ${a.city}, ${a.country}` };
    }
    let estimateBand: ISellRequest['estimateBand'];
    if (input.estimateId) {
      const e = await EstimateModel.findOne({ _id: input.estimateId, userId: input.userId }).lean<IEstimate>();
      if (!e) throw unprocessable('Estimate not found', { estimateId: 'Unknown estimate' });
      estimateBand = { low: e.low, high: e.high };
    }
    if (input.payoutAccountId) await payoutsService.getAccount(input.userId, input.payoutAccountId);

    try {
      const doc = await SellRequestModel.create({
        reference: await references.sellRequest(),
        userId: input.userId,
        tier: input.tier,
        estimateId: input.estimateId,
        mineralTypeId: m.id,
        mineralName: m.name,
        grams: input.grams,
        photoIds: input.photoIds,
        pickup,
        evaluation: { at: slotAt(input.slotKey), slotKey: input.slotKey },
        payoutAccountId: input.payoutAccountId,
        status: 'booked',
        timeline: [pushTimeline('booked')],
        estimateBand,
        activeSlotKey: input.slotKey,
        version: 0,
      });
      return doc._id;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw conflict('sell/slot-taken', 'That evaluation slot was just taken. Pick another.');
      throw err;
    }
  },

  /** Lazily expires an open, un-paused offer whose clock ran out. */
  async fresh(r: ISellRequest): Promise<ISellRequest> {
    const o = r.offer;
    if (r.status === 'offer_ready' && o && o.status === 'open' && !o.pausedAt && o.expiresAt <= now()) {
      const updated = await SellRequestModel.findOneAndUpdate(
        { _id: r._id, status: 'offer_ready', 'offer.status': 'open', 'offer.version': o.version },
        { $set: { status: 'expired', 'offer.status': 'expired' }, $unset: { activeSlotKey: '' }, $push: { timeline: pushTimeline('expired') }, $inc: { version: 1 } },
        { new: true },
      ).lean<ISellRequest>();
      return updated ?? (await SellRequestModel.findById(r._id).lean<ISellRequest>())!;
    }
    return r;
  },

  async get(userId: string, id: string): Promise<ISellRequest> {
    const r = await SellRequestModel.findOne({ _id: id, userId }).lean<ISellRequest>();
    if (!r) throw notFound('sell/request-not-found', 'Sell request not found');
    return this.fresh(r);
  },

  async list(userId: string, status: 'active' | 'closed' | undefined, skip: number, limit: number) {
    const closed: SellStatus[] = ['sold', 'declined', 'expired', 'cancelled'];
    const filter: FilterQuery<ISellRequest> = { userId, ...(status === 'closed' ? { status: { $in: closed } } : status === 'active' ? { status: { $nin: closed } } : {}) };
    const [rows, total, active] = await Promise.all([
      SellRequestModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean<ISellRequest[]>(),
      SellRequestModel.countDocuments(filter),
      SellRequestModel.countDocuments({ userId, status: { $nin: closed } }),
    ]);
    const fresh = await Promise.all(rows.map((r) => this.fresh(r)));
    return { rows: fresh, total, counts: { active } };
  },

  async documents(userId: string, id: string): Promise<ISellDocument[]> {
    await this.get(userId, id);
    return SellDocumentModel.find({ requestId: id }).sort({ _id: 1 }).lean<ISellDocument[]>();
  },

  async cancel(userId: string, id: string) {
    const r = await this.get(userId, id);
    sellMachine.assert(r.status, 'cancelled');
    const u = await SellRequestModel.findOneAndUpdate(
      { _id: id, userId, version: r.version, status: r.status },
      { $set: { status: 'cancelled' }, $unset: { activeSlotKey: '' }, $push: { timeline: pushTimeline('cancelled') }, $inc: { version: 1 } },
      { new: true },
    ).lean<ISellRequest>();
    if (!u) throw conflict('sell/request-changed', 'The request changed. Refresh and try again.');
    return publishSell(u);
  },

  /** Why an offer CAS lost: classify so the client gets a stable, actionable error. */
  async offerConflict(userId: string, id: string, expectedVersion: number | undefined): Promise<never> {
    const r = await this.get(userId, id);
    const o = r.offer;
    if (!o || r.status === 'booked' || r.status === 'evaluating') throw conflict('sell/no-open-offer', 'There is no open offer on this request.');
    if (o.status === 'expired' || r.status === 'expired') throw gone('sell/offer-expired', 'This offer has expired.');
    if (o.status !== 'open') throw conflict('sell/offer-closed', `This offer was already ${o.status}.`);
    if (o.pausedAt) throw conflict('sell/offer-under-review', 'This offer is under review and cannot be accepted right now.');
    if (expectedVersion !== undefined && o.version !== expectedVersion) throw conflict('sell/offer-changed', 'The offer changed. Review the latest terms.', { current: { version: o.version } } as never);
    throw conflict('sell/offer-unavailable', 'This offer can no longer be actioned.');
  },

  async acceptOffer(userId: string, id: string, input: { version: number; payoutAccountId?: string }) {
    const r = await this.get(userId, id);
    sellMachine.assert(r.status, 'sold');
    let accountId = input.payoutAccountId ?? r.payoutAccountId;
    if (!accountId) {
      const accounts = await payoutsService.listAccounts(userId);
      accountId = (accounts.find((a) => a.isDefault) ?? accounts[0])?._id;
    }
    if (!accountId) throw unprocessable('Add a payout account before accepting', { payoutAccountId: 'Required' }, 'sell/payout-account-required');
    const acct = await payoutsService.getAccount(userId, accountId);
    if (acct.status !== 'verified') throw conflict('payout/account-not-verified', 'This payout account is not verified yet');

    const updated = await SellRequestModel.findOneAndUpdate(
      { _id: id, userId, status: 'offer_ready', 'offer.status': 'open', 'offer.version': input.version, 'offer.pausedAt': { $exists: false }, 'offer.expiresAt': { $gt: now() } },
      {
        $set: { status: 'sold', 'offer.status': 'accepted', 'offer.decision': { at: now(), payoutAccountId: acct._id }, payoutAccountId: acct._id },
        $unset: { activeSlotKey: '' },
        $push: { timeline: pushTimeline('sold') },
        $inc: { version: 1, 'offer.version': 1 },
      },
      { new: true },
    ).lean<ISellRequest>();
    if (!updated) return this.offerConflict(userId, id, input.version);

    const offer = updated.offer as ISellOffer;
    await walletService.credit(userId, offer.amount.amountMinor, offer.amount.currency, 'sale_proceeds', { type: 'sell_request', id }, `Sale ${updated.reference}`);
    await notifyUser(userId, { event: 'sell.paid', title: 'Offer accepted', body: `Proceeds for ${updated.reference} were added to your balance.`, target: { type: 'sell_request', id } });
    return publishSell(updated);
  },

  async declineOffer(userId: string, id: string, input: { version?: number; reason?: string; note?: string }) {
    const r = await this.get(userId, id);
    sellMachine.assert(r.status, 'declined');
    const filter: FilterQuery<ISellRequest> = { _id: id, userId, status: 'offer_ready', 'offer.status': 'open' };
    if (input.version !== undefined) filter['offer.version'] = input.version;
    const updated = await SellRequestModel.findOneAndUpdate(
      filter,
      { $set: { status: 'declined', 'offer.status': 'declined', 'offer.decision': { at: now(), reason: input.reason, note: input.note } }, $unset: { activeSlotKey: '' }, $push: { timeline: pushTimeline('declined') }, $inc: { version: 1, 'offer.version': 1 } },
      { new: true },
    ).lean<ISellRequest>();
    if (!updated) return this.offerConflict(userId, id, input.version);
    return publishSell(updated);
  },

  /** Pauses the offer clock and opens a desk review ticket (M-4). One review at a time. */
  async requestReview(userId: string, id: string, input: { version?: number; note?: string }) {
    const r = await this.get(userId, id);
    if (r.status !== 'offer_ready' || r.offer?.status !== 'open') return this.offerConflict(userId, id, input.version);
    if (r.offer.pausedAt) throw conflict('sell/review-already-requested', 'A review is already open for this offer.');
    const ticket = await SupportTicketModel.create({
      reference: await references.ticket(),
      userId,
      topic: 'sell_offer_review',
      subject: `Offer review ${r.reference}`,
      body: input.note ?? 'Customer requested a review of the offer.',
      relatedTo: { type: 'sell_request', id },
      status: 'open',
      messages: [],
      attachmentIds: [],
      version: 0,
    });
    const filter: FilterQuery<ISellRequest> = { _id: id, userId, status: 'offer_ready', 'offer.status': 'open', 'offer.pausedAt': { $exists: false } };
    if (input.version !== undefined) filter['offer.version'] = input.version;
    const updated = await SellRequestModel.findOneAndUpdate(
      filter,
      { $set: { 'offer.pausedAt': now(), 'offer.reviewTicketId': ticket._id }, $push: { timeline: pushTimeline('review_requested') }, $inc: { version: 1, 'offer.version': 1 } },
      { new: true },
    ).lean<ISellRequest>();
    if (!updated) return this.offerConflict(userId, id, input.version);
    return publishSell(updated);
  },

  /* -- desk-side transitions (called by the admin console / jobs) ------------------------- */
  desk: {
    async startEvaluation(id: string, evaluator: { id: string; name: string; subtitle?: string }) {
      const r = await SellRequestModel.findById(id).lean<ISellRequest>();
      if (!r) throw notFound('sell/request-not-found', 'Sell request not found');
      sellMachine.assert(r.status, 'evaluating');
      const u = await SellRequestModel.findOneAndUpdate(
        { _id: id, version: r.version, status: r.status },
        { $set: { status: 'evaluating', evaluator: { ...evaluator, onSite: true, checkedInAt: now() } }, $push: { timeline: pushTimeline('evaluating') }, $inc: { version: 1 } },
        { new: true },
      ).lean<ISellRequest>();
      if (!u) throw conflict('sell/request-changed', 'The request changed concurrently.');
      await notifyUser(r.userId, { event: 'sell.evaluator_assigned', title: 'Evaluator on site', body: evaluator.name, target: { type: 'sell_request', id } });
      return publishSell(u);
    },

    async issueOffer(id: string, input: { amountMinor: number; currency?: string; validityHours?: number; assay: ISellOffer['assay'] }) {
      const r = await SellRequestModel.findById(id).lean<ISellRequest>();
      if (!r) throw notFound('sell/request-not-found', 'Sell request not found');
      sellMachine.assert(r.status, 'offer_ready');
      const validityHours = input.validityHours ?? OFFER_VALIDITY_HOURS;
      const offer: ISellOffer = {
        _id: opaqueId('ofr'),
        status: 'open',
        amount: { amountMinor: input.amountMinor, currency: input.currency ?? 'USD' },
        issuedAt: now(),
        expiresAt: addMs(now(), validityHours * HOUR_MS),
        validityHours,
        assay: input.assay,
        version: (r.offer?.version ?? 0) + 1,
      };
      const u = await SellRequestModel.findOneAndUpdate(
        { _id: id, version: r.version, status: r.status },
        { $set: { status: 'offer_ready', offer }, $push: { timeline: pushTimeline('offer_ready') }, $inc: { version: 1 } },
        { new: true },
      ).lean<ISellRequest>();
      if (!u) throw conflict('sell/request-changed', 'The request changed concurrently.');
      await notifyUser(r.userId, { event: 'sell.offer_ready', title: 'Your offer is ready', body: r.reference, target: { type: 'sell_request', id } });
      return publishSell(u);
    },

    /** Resumes the clock after a review: remaining validity is restored from the pause point. */
    async resolveReview(id: string, revisedAmountMinor?: number) {
      const r = await SellRequestModel.findById(id).lean<ISellRequest>();
      if (!r?.offer?.pausedAt) throw conflict('sell/no-review-open', 'No review is open');
      const remaining = Math.max(0, r.offer.expiresAt.getTime() - r.offer.pausedAt.getTime());
      const set: Record<string, unknown> = { 'offer.expiresAt': addMs(now(), Math.max(remaining, 6 * HOUR_MS)) };
      if (revisedAmountMinor !== undefined) set['offer.amount'] = { amountMinor: revisedAmountMinor, currency: r.offer.amount.currency };
      const u = await SellRequestModel.findOneAndUpdate(
        { _id: id, 'offer.pausedAt': { $exists: true } },
        { $set: set, $unset: { 'offer.pausedAt': '' }, $push: { timeline: pushTimeline('review_resolved') }, $inc: { version: 1, 'offer.version': 1 } },
        { new: true },
      ).lean<ISellRequest>();
      if (!u) throw conflict('sell/request-changed', 'The request changed concurrently.');
      return publishSell(u);
    },
  },

  /* -- bulk quotes (tier 3) --------------------------------------------------------------- */
  async valuation(input: { mineralTypeId: string; grams: number; purityPct: number }) {
    const m = await resolveMineral(input.mineralTypeId);
    const { e4, asOf } = await deskRateE4(m.mineralCode);
    const b = band(input.grams, e4, input.purityPct, FEES.webSellPlatformBps);
    return { mineral: m, band: { low: { amountMinor: b.low, currency: 'USD' }, high: { amountMinor: b.high, currency: 'USD' } }, deskReferenceE4PerGram: e4, asOf };
  },

  async createBulk(
    userId: string,
    tier: number,
    input: { mineralTypeId: string; grams: number; purityPct: number; photoIds: string[]; offtakePartner?: string; origin?: { site?: string; extractionDate?: string }; description?: string; facility: Record<string, string>; exportPermitNumber: string; proofOfAddressDocumentId?: string; idempotencyKey: string },
  ) {
    if (tier !== 3) throw forbidden('sell/bulk-tier-required', 'Bulk quotes are available to Tier 3 accounts only');
    const out = await runIdempotent<{ id: string }>({
      scope: idempotencyScope(userId, 'bulk:create'),
      key: input.idempotencyKey,
      body: { ...input, idempotencyKey: undefined },
      successStatus: 201,
      fn: async () => {
        if (input.photoIds.length) await uploadsService.ownedMany(userId, input.photoIds);
        const v = await this.valuation(input);
        const doc = await BulkQuoteModel.create({
          reference: await references.bulkQuote(),
          userId,
          mineralTypeId: v.mineral.id,
          mineralName: v.mineral.name,
          grams: input.grams,
          purityPct: input.purityPct,
          photoIds: input.photoIds,
          offtakePartner: input.offtakePartner,
          origin: input.origin,
          description: input.description,
          facility: input.facility,
          exportPermitNumber: input.exportPermitNumber,
          proofOfAddressDocumentId: input.proofOfAddressDocumentId,
          status: 'desk_pricing',
          band: v.band,
          deskReferenceE4PerGram: v.deskReferenceE4PerGram,
          expectedOfferBy: addMs(now(), 72 * HOUR_MS),
          timeline: [pushTimeline('submitted')],
          version: 0,
        });
        return { id: doc._id };
      },
    });
    return { id: out.result.id, replayed: out.replayed };
  },

  async getBulk(userId: string, id: string): Promise<IBulkQuote> {
    const q = await BulkQuoteModel.findOne({ _id: id, userId }).lean<IBulkQuote>();
    if (!q) throw notFound('sell/bulk-quote-not-found', 'Bulk quote not found');
    return q;
  },

  async listBulk(userId: string, skip: number, limit: number) {
    const [rows, total] = await Promise.all([
      BulkQuoteModel.find({ userId }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean<IBulkQuote[]>(),
      BulkQuoteModel.countDocuments({ userId }),
    ]);
    return { rows, total };
  },
};
