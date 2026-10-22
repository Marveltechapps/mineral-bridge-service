import { conflict, notFound, unprocessable } from '../../common/errors/app-error.js';
import { idempotencyScope, runIdempotent } from '../../common/idempotency/idempotency.js';
import { now } from '../../common/utils/clock.js';
import { opaqueId } from '../../common/utils/ids.js';
import { feeMinor, FEES, totalMinor } from '../../common/utils/pricing-math.js';
import { references } from '../../common/utils/references.js';
import { StateMachine } from '../../common/utils/state-machine.js';
import { ProductModel } from '../../models/catalog.model.js';
import { ListingModel } from '../../models/web-trade.model.js';
import { catalogService } from '../catalog/catalog.service.js';
import type { IListing, ListingStatus } from '../../models/web-trade.model.js';
import { contentService } from '../content/content.service.js';
import { notifyUser } from '../notifications/notifications.service.js';
import { payoutsService } from '../payouts/payouts.service.js';
import { uploadsService } from '../uploads/uploads.service.js';
import { projectCustomerListing, safeProject } from '../../integration/customer-admin.bridge.js';

export const listingMachine = new StateMachine<ListingStatus>(
  'listing',
  {
    draft: ['submitted'],
    submitted: ['visit_scheduled', 'rejected'],
    visit_scheduled: ['verified', 'rejected'],
    verified: ['in_transit', 'rejected'],
    in_transit: ['received'],
    received: ['paid'],
    paid: [],
    rejected: [],
  },
  'listing/invalid-transition',
);

const ASSUMED_PURITY_PCT = 85;
const MAX_PHOTOS = 8;

export type ListingInput = {
  mineralId?: string | null;
  customMineralName?: string | null;
  quantityGrams: number;
  form: IListing['form'];
  verificationAddress: IListing['verificationAddress'];
  preferredSlot: IListing['preferredSlot'];
  payoutMethodId?: string | null;
  payoutPreference?: string;
};

async function resolveMineral(input: Pick<ListingInput, 'mineralId' | 'customMineralName'>) {
  if (input.mineralId) {
    const types = await catalogService.types();
    const type = types.find((t) => t.slug === input.mineralId || t._id === input.mineralId);
    if (type) return { code: type.mineralCode ?? type.slug, name: type.name, category: type.categorySlug };
    const product = await ProductModel.findById(input.mineralId).lean();
    if (product) return { code: product.mineralCode, name: product.name, category: product.categorySlug };
    const m = (await contentService.reference('mineral')).find((x) => x.code === input.mineralId);
    if (!m) throw unprocessable('Unknown mineral', { mineralId: 'Unknown mineral' }, 'listing/unknown-mineral');
    return { code: m.code, name: m.name, category: String((m.data as { category?: string }).category ?? 'other') };
  }
  if (!input.customMineralName) throw unprocessable('Pick a mineral or describe it', { mineralId: 'Required' });
  return { code: null, name: input.customMineralName, category: 'other' };
}

/** Server-side quote: the client never supplies money. Custom minerals have no desk rate, so no quote. */
export async function quoteListing(mineralCode: string | null, grams: number) {
  if (!mineralCode) return null;
  const rate = (await contentService.rates()).find((r) => r.mineralCode === mineralCode);
  if (!rate) return null;
  const gross = totalMinor(Math.round((grams * ASSUMED_PURITY_PCT) / 100), rate.unitPriceMinorE4PerGram);
  const fee = feeMinor(gross, FEES.webSellPlatformBps);
  return {
    gross: { amountMinor: gross, currency: rate.currency },
    fee: { amountMinor: fee, currency: rate.currency },
    net: { amountMinor: gross - fee, currency: rate.currency },
    feeBps: FEES.webSellPlatformBps,
    assumedPurityPct: ASSUMED_PURITY_PCT,
    asOf: rate.asOf,
  };
}

export const listingsService = {
  async quote(input: Pick<ListingInput, 'mineralId' | 'customMineralName' | 'quantityGrams'>) {
    const m = await resolveMineral(input);
    return { mineral: m, quote: await quoteListing(m.code, input.quantityGrams) };
  },

  async create(userId: string, input: ListingInput & { submit?: boolean; photoFileIds?: string[]; idempotencyKey: string }) {
    const out = await runIdempotent<{ id: string }>({
      scope: idempotencyScope(userId, 'listing:create'),
      key: input.idempotencyKey,
      body: { ...input, idempotencyKey: undefined },
      successStatus: 201,
      fn: async () => ({ id: await this.createOnce(userId, input) }),
    });
    return { id: out.result.id, replayed: out.replayed };
  },

  async createOnce(userId: string, input: ListingInput & { submit?: boolean; photoFileIds?: string[] }): Promise<string> {
    const m = await resolveMineral(input);
    const photoFileIds = input.photoFileIds ?? [];
    if (photoFileIds.length > MAX_PHOTOS) throw unprocessable('Too many photos', { photoFileIds: `Max ${MAX_PHOTOS}` });
    if (photoFileIds.length) await uploadsService.ownedMany(userId, photoFileIds);
    if (input.payoutMethodId) await payoutsService.getAccount(userId, input.payoutMethodId);
    const q = await quoteListing(m.code, input.quantityGrams);
    const submit = Boolean(input.submit);
    if (submit && photoFileIds.length === 0) throw unprocessable('Add at least one photo before submitting', { photoFileIds: 'At least one photo required' }, 'listing/photos-required');
    const doc = await ListingModel.create({
      reference: await references.listing(),
      userId,
      mineralId: m.code,
      mineralName: m.name,
      customMineralName: m.code ? undefined : m.name,
      categoryKey: m.category,
      grams: input.quantityGrams,
      form: input.form,
      verificationAddress: input.verificationAddress,
      preferredSlot: input.preferredSlot,
      payoutMethodId: input.payoutMethodId ?? undefined,
      payoutPreference: input.payoutPreference,
      photos: photoFileIds.map((fileId) => ({ _id: opaqueId('pho'), fileId, addedAt: now() })),
      status: submit ? 'submitted' : 'draft',
      indicativeNet: q?.net,
      quoteSnapshot: q ? { gross: q.gross, fee: q.fee, net: q.net, feeBps: q.feeBps } : undefined,
      submittedAt: submit ? now() : undefined,
      version: 0,
    });
    if (submit) await safeProject('listing', () => projectCustomerListing(doc.toObject() as IListing));
    return doc._id as string;
  },

  async get(userId: string, id: string): Promise<IListing> {
    const l = await ListingModel.findOne({ _id: id, userId }).lean<IListing>();
    if (!l) throw notFound('listing/not-found', 'Listing not found');
    return l;
  },

  async list(userId: string, status: ListingStatus | undefined, skip: number, limit: number) {
    const filter = { userId, ...(status ? { status } : {}) };
    const [rows, total] = await Promise.all([
      ListingModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean<IListing[]>(),
      ListingModel.countDocuments(filter),
    ]);
    return { rows, total };
  },

  /** Edits are only allowed while the listing is a draft; `submit: true` moves it to `submitted`. */
  async patch(userId: string, id: string, patch: Partial<ListingInput> & { submit?: boolean; version?: number }) {
    const l = await this.get(userId, id);
    if (l.status !== 'draft') throw conflict('listing/not-editable', 'Only draft listings can be edited.', { current: { status: l.status } } as never);
    if (patch.version !== undefined && patch.version !== l.version) throw conflict('listing/version-conflict', 'The listing changed. Refresh and try again.');
    const set: Record<string, unknown> = {};
    if (patch.mineralId !== undefined || patch.customMineralName !== undefined) {
      const m = await resolveMineral({ mineralId: patch.mineralId ?? undefined, customMineralName: patch.customMineralName ?? undefined });
      Object.assign(set, { mineralId: m.code, mineralName: m.name, customMineralName: m.code ? null : m.name, categoryKey: m.category });
    }
    if (patch.quantityGrams) set.grams = patch.quantityGrams;
    if (patch.form) set.form = patch.form;
    if (patch.verificationAddress) set.verificationAddress = patch.verificationAddress;
    if (patch.preferredSlot) set.preferredSlot = patch.preferredSlot;
    if (patch.payoutMethodId !== undefined) {
      if (patch.payoutMethodId) await payoutsService.getAccount(userId, patch.payoutMethodId);
      set.payoutMethodId = patch.payoutMethodId;
    }
    if (patch.payoutPreference !== undefined) set.payoutPreference = patch.payoutPreference;
    // Re-quote when what is being sold changed.
    if (set.grams || set.mineralId !== undefined) {
      const code = (set.mineralId as string | null | undefined) ?? l.mineralId ?? null;
      const q = await quoteListing(code, (set.grams as number | undefined) ?? l.grams);
      set.indicativeNet = q?.net ?? null;
      set.quoteSnapshot = q ? { gross: q.gross, fee: q.fee, net: q.net, feeBps: q.feeBps } : null;
    }
    if (patch.submit) {
      listingMachine.assert(l.status, 'submitted');
      if (l.photos.length === 0) throw unprocessable('Add at least one photo before submitting', { photos: 'At least one photo required' }, 'listing/photos-required');
      set.status = 'submitted';
      set.submittedAt = now();
    }
    const updated = await ListingModel.findOneAndUpdate({ _id: id, userId, version: l.version, status: 'draft' }, { $set: set, $inc: { version: 1 } }, { new: true }).lean<IListing>();
    if (!updated) throw conflict('listing/version-conflict', 'The listing changed. Refresh and try again.');
    if (updated.status === 'submitted') await safeProject('listing', () => projectCustomerListing(updated));
    return updated;
  },

  async addPhoto(userId: string, id: string, fileId: string) {
    const l = await this.get(userId, id);
    if (l.status !== 'draft' && l.status !== 'submitted') throw conflict('listing/not-editable', 'Photos can no longer be added to this listing.');
    if (l.photos.length >= MAX_PHOTOS) throw conflict('listing/photo-limit', `A listing can have at most ${MAX_PHOTOS} photos.`);
    await uploadsService.owned(userId, fileId);
    if (l.photos.some((p) => p.fileId === fileId)) return l;
    const updated = await ListingModel.findOneAndUpdate(
      { _id: id, userId, 'photos.fileId': { $ne: fileId }, 'photos.7': { $exists: false } },
      { $push: { photos: { _id: opaqueId('pho'), fileId, addedAt: now() } }, $inc: { version: 1 } },
      { new: true },
    ).lean<IListing>();
    return updated ?? this.get(userId, id);
  },

  async removePhoto(userId: string, id: string, photoId: string) {
    const l = await this.get(userId, id);
    if (l.status !== 'draft' && l.status !== 'submitted') throw conflict('listing/not-editable', 'Photos can no longer be removed from this listing.');
    if (!l.photos.some((p) => p._id === photoId)) throw notFound('listing/photo-not-found', 'Photo not found');
    const updated = await ListingModel.findOneAndUpdate(
      { _id: id, userId, version: l.version },
      { $pull: { photos: { _id: photoId } }, $inc: { version: 1 } },
      { new: true },
    ).lean<IListing>();
    return updated ?? this.get(userId, id);
  },

  /** Desk-side transitions (admin console / jobs). */
  desk: {
    async transition(id: string, to: ListingStatus, extra: Record<string, unknown> = {}) {
      const l = await ListingModel.findById(id).lean<IListing>();
      if (!l) throw notFound('listing/not-found', 'Listing not found');
      listingMachine.assert(l.status, to);
      const updated = await ListingModel.findOneAndUpdate({ _id: id, version: l.version, status: l.status }, { $set: { status: to, ...extra }, $inc: { version: 1 } }, { new: true }).lean<IListing>();
      if (!updated) throw conflict('listing/version-conflict', 'The listing changed concurrently.');
      await notifyUser(l.userId, { event: 'sell.evaluator_assigned', title: `Listing ${l.reference}: ${to.replace(/_/g, ' ')}`, target: { type: 'listing', id } });
      return updated;
    },
  },
};
