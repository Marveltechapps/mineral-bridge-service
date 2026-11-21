import { notFound } from '../../../common/errors/app-error.js';
import { percentOfMinor, type StoredMoney } from '../../../common/utils/money.js';
import { VaultLot } from '../../../models/trading.models.js';
import { daysBetween, iso } from '../shared/http.js';
import { loadFileRefs } from '../shared/files.js';
import { outMoney, outQty, outUnitPrice } from '../shared/money.js';
import { loadPartnerMap } from '../shared/refs.js';
import { loadRateIndex, realisableOf, type RateDoc } from '../pricing/rates.service.js';

export const LOT_SORT: Record<string, string> = { id: 'lotId', mineral: 'mineral.name', status: 'status', daysHeld: 'heldSince' };

export const IN_CUSTODY = { status: { $ne: 'shipped' } };

export function lotSummary(l: any) {  
  return {
    id: l.lotId,
    mineral: l.mineral?.name,
    quantity: outQty(l.quantity),
    grade: l.grade ?? '',
    sourceOrderId: l.sourceOrderId ?? '',
    status: l.status,
    daysHeld: daysBetween(l.heldSince ?? l.createdAt),
  };
}

/** Suggested allocation prefills (#36 suggestions, #54): start at cost, reserve +6 %, ask = realisable. */
export function suggestionsFor(costBasis: StoredMoney | undefined, realisable: StoredMoney | undefined) {
  const cost = costBasis ?? realisable;
  const real = realisable ?? costBasis;
  if (!cost || !real) return null;
  const reserve: StoredMoney = { ...cost, amountMinor: cost.amountMinor + percentOfMinor(cost.amountMinor, 600) };
  return {
    askPrice: outMoney(real),
    startingBid: outMoney(cost),
    reserve: outMoney(reserve),
    increment: outMoney({ ...cost, amountMinor: Math.max(1, percentOfMinor(cost.amountMinor, 100)) }),
  };
}

export async function mapLotDetail(l: any, index?: Map<string, RateDoc>) {  
  const idx = index ?? (await loadRateIndex());
  const { realisable, rate } = realisableOf(l, idx);
  const [files, partners] = await Promise.all([
    loadFileRefs([...(l.photos ?? []).map((p: { fileId: string }) => p.fileId), l.assay?.fileId]),
    loadPartnerMap([l.assay?.labId]),
  ]);
  const cost = l.costBasis as StoredMoney | undefined;
  const unrealised = cost && realisable ? { ...cost, amountMinor: realisable.amountMinor - cost.amountMinor } : undefined;
  return {
    ...lotSummary(l),
    location: l.location ?? '',
    costBasis: outMoney(cost),
    costRate: outUnitPrice(l.costRate),
    realisable: outMoney(realisable),
    liveSellRate: outUnitPrice(rate?.sell),
    unrealised: outMoney(unrealised),
    unrealisedPct: cost && unrealised && cost.amountMinor ? Number(((unrealised.amountMinor / cost.amountMinor) * 100).toFixed(1)) : 0,
    custody: (l.custody ?? []).map((c: { title: string; description: string; at?: Date; actor: string; state: string }) => ({ title: c.title, description: c.description, at: iso(c.at), actor: c.actor, state: c.state })),
    photos: (l.photos ?? []).map((p: { fileId: string; label: string }) => ({ ...(files.get(p.fileId) ?? { id: p.fileId }), label: p.label })),
    assay: l.assay?.certificateNo
      ? {
          certificateNo: l.assay.certificateNo,
          fileId: l.assay.fileId ?? null,
          lab: l.assay.labId ? partners.get(l.assay.labId) ?? null : null,
          date: iso(l.assay.date),
          grade: l.assay.grade ?? l.grade ?? '',
          method: l.assay.method ?? '',
          netQuantity: outQty(l.assay.netQuantity),
        }
      : null,
    allocationHistory: (l.allocationHistory ?? []).map((h: { title: string; sub: string; date: Date; amount?: StoredMoney }) => ({ title: h.title, sub: h.sub, date: iso(h.date), ...(h.amount ? { amount: outMoney(h.amount) } : {}) })),
    suggestions: suggestionsFor(cost, realisable),
    hold: l.hold?.reason ? { reason: l.hold.reason, reviewOn: l.hold.reviewOn, visibleInUnallocatedQueue: Boolean(l.hold.visibleInUnallocatedQueue) } : null,
    ...(l.listingId ? { listingId: l.listingId } : {}),
    ...(l.auctionId ? { auctionId: l.auctionId } : {}),
    ...(l.passportId ? { passportId: l.passportId } : {}),
  };
}

export async function requireLot(lotId: string) {
  const l = await VaultLot.findOne({ lotId }).lean();
  if (!l) throw notFound('resource/not-found', `Lot ${lotId} not found`);
  return l;
}
