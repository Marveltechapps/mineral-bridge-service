import type { ClientSession } from 'mongoose';
import { AppError, conflict, notFound } from '../../../common/errors/app-error.js';
import { docEtag } from '../../../common/http/etag.js';
import { nextId } from '../../../common/db/sequence.js';
import { Listing, Order, VaultLot } from '../../../models/trading.models.js';
import { BUYER_ACCESS } from '../shared/enums.js';
import { iso } from '../shared/http.js';
import { convertQty, outMoney, outQty, outUnitPrice, priceTimesQuantity, type QuantityUnit, type StoredUnitPrice } from '../shared/money.js';
import { loadRateIndex, lookupRate } from '../pricing/rates.service.js';

export const LISTING_SORT: Record<string, string> = { id: 'listingId', mineral: 'mineral.name', price: 'askPrice.amountMinor', value: 'askPrice.amountMinor', views: 'views', status: 'status' };

export function listingDto(l: any) {  
  const listedValue = l.askPrice && l.quantityLeft ? priceTimesQuantity(l.askPrice, l.quantityLeft) : undefined;
  return {
    id: l.listingId,
    lotId: l.lotId,
    mineral: l.mineral?.name,
    grade: l.grade ?? '',
    quantityTotal: outQty(l.quantityTotal),
    quantityLeft: outQty(l.quantityLeft),
    askPrice: outUnitPrice(l.askPrice),
    listedValue: outMoney(listedValue),
    status: l.status,
    access: l.access,
    views: l.views ?? 0,
    enquiries: l.enquiries ?? 0,
    listedAt: iso(l.listedAt),
    opensAt: iso(l.opensAt),
    featured: Boolean(l.featured),
  };
}

export async function listingDetailDto(l: any) {  
  const idx = await loadRateIndex();
  const rate = lookupRate(idx, l.mineral?.name ?? '', l.grade);
  const total = l.quantityTotal?.value ?? 0;
  const left = l.quantityLeft?.value ?? 0;
  return {
    ...listingDto(l),
    soldPct: total ? Number((((total - left) / total) * 100).toFixed(1)) : 0,
    priceFloor: outUnitPrice(l.priceFloor),
    minParcel: { kind: l.minParcel?.kind ?? 'percent', value: l.minParcel?.value ?? 10, ...(l.minParcel?.unit ? { unit: l.minParcel.unit } : {}) },
    description: l.description ?? '',
    showAssayToBuyers: Boolean(l.showAssayToBuyers),
    liveSellRate: outUnitPrice(rate?.sell),
    etag: docEtag(l),
  };
}

export async function requireListing(listingId: string) {
  const l = await Listing.findOne({ listingId }).lean();
  if (!l) throw notFound('resource/not-found', `Listing ${listingId} not found`);
  return l;
}

export type CreateListingInput = {
  lotId: string;
  askPrice: StoredUnitPrice;
  quantity?: { value: number; unit: QuantityUnit } | null;
  minParcel?: { kind: 'percent' | 'quantity'; value: number; unit?: string };
  access?: (typeof BUYER_ACCESS)[number];
  showAssayToBuyers?: boolean;
  note?: string;
  opensAt?: Date | null;
  sourceAuctionId?: string | null;
  priceFloor?: StoredUnitPrice;
  featured?: boolean;
  draft?: boolean;
  confirmBelowCost?: boolean;
  createdBy: string;
};

/**
 * Publishes (or drafts) a vault lot as a catalog listing. Shared by #40 and by auction relist → catalog (#66).
 * The lot is claimed atomically (in_vault → listed) so a lot can never be allocated twice.
 */
export async function createListingFromLot(input: CreateListingInput, session?: ClientSession, allowStatuses: string[] = ['in_vault']) {
  const lot = await VaultLot.findOne({ lotId: input.lotId }, null, { session }).lean();
  if (!lot) throw notFound('resource/not-found', `Lot ${input.lotId} not found`);
  if (!allowStatuses.includes(lot.status)) {
    throw conflict('conflict/stale-state', `${input.lotId} is not available to list (${lot.status.replace('_', ' ')}).`, { details: { status: lot.status } });
  }
  const lotUnit = lot.quantity.unit as QuantityUnit;
  const qty = input.quantity ?? { value: lot.quantity.value, unit: lotUnit };
  if (convertQty(qty.value, qty.unit, lotUnit) > lot.quantity.value + 1e-9) {
    throw new AppError({ status: 422, code: 'rule/quantity-exceeds-lot', message: `Quantity exceeds the ${lot.quantity.value} ${lotUnit} in ${input.lotId}.`, fields: { quantity: 'Exceeds lot quantity' } });
  }
  if (lot.costBasis && !input.confirmBelowCost) {
    const value = priceTimesQuantity(input.askPrice, qty);
    const costShare = lot.costBasis.amountMinor * (convertQty(qty.value, qty.unit, lotUnit) / lot.quantity.value);
    if (value.amountMinor < costShare) {
      throw new AppError({ status: 422, code: 'rule/ask-below-cost', message: 'Ask price is below cost. Confirm to publish anyway.', details: { confirmWith: 'confirmBelowCost' } });
    }
  }
  const listingId = await nextId('listing', session);
  const now = new Date();
  const scheduled = Boolean(input.opensAt && input.opensAt.getTime() > now.getTime());
  const status = input.draft ? 'draft' : scheduled ? 'scheduled' : 'live';

  if (!input.draft) {
    const claimed = await VaultLot.findOneAndUpdate(
      { lotId: input.lotId, status: { $in: allowStatuses } },
      { $set: { status: 'listed', listingId }, $push: { allocationHistory: { title: 'Listed in Buy catalog', sub: listingId, date: now, amount: priceTimesQuantity(input.askPrice, qty) } } },
      { new: true, session },
    ).lean();
    if (!claimed) throw conflict('conflict/stale-state', `${input.lotId} was just allocated — refresh and try again.`);
  }
  const [doc] = await Listing.create(
    [
      {
        listingId,
        lotId: input.lotId,
        mineral: lot.mineral,
        grade: lot.grade,
        quantityTotal: qty,
        quantityLeft: qty,
        askPrice: input.askPrice,
        priceFloor: input.priceFloor,
        minParcel: input.minParcel ?? { kind: 'percent', value: 10 },
        status,
        access: input.access ?? 'all_verified',
        listedAt: status === 'live' ? now : undefined,
        opensAt: input.opensAt ?? undefined,
        featured: input.featured ?? false,
        description: input.note ?? '',
        showAssayToBuyers: input.showAssayToBuyers ?? true,
        sourceAuctionId: input.sourceAuctionId ?? undefined,
        createdBy: input.createdBy,
      },
    ],
    { session },
  );
  return { listing: doc.toObject(), lot };
}

/** Sum of buy-order value created from listings in a window (used by #38). */
export async function soldFromListings(from: Date) {
  const rows = await Order.aggregate([
    { $match: { side: 'buy', listingId: { $exists: true, $ne: null }, status: { $in: ['active', 'completed'] }, openedAt: { $gte: from }, $or: [{ priceConfirmedAt: { $type: 'date' } }, { paymentStatus: 'released' }] } },
    { $group: { _id: '$value.currency', minor: { $sum: '$value.amountMinor' }, n: { $sum: 1 } } },
  ]);
  return rows;
}
