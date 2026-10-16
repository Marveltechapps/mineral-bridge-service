import { z } from 'zod';
import { AppError, conflict } from '../../../common/errors/app-error.js';
import { withTx } from '../../../common/db/transaction.js';
import { assertIfMatch, docEtag, setEtag } from '../../../common/http/etag.js';
import { Listing, VaultLot } from '../../../models/trading.models.js';
import { auditActor } from '../shared/staff-context.js';
import { recordAudit } from '../../audit/audit.service.js';
import { BUYER_ACCESS, LISTING_STATUSES } from '../shared/enums.js';
import { action, and, boolQ, daysBetween, oneOf, pageOf, paging, searchFilter, sortSpec } from '../shared/http.js';
import { adminQuantitySchema, adminUnitPriceSchema, addStored, convertQty, outMoneyOrZero, parseUnitPrice, priceTimesQuantity, zeroStored, QUANTITY_UNITS, type QuantityUnit } from '../shared/money.js';
import { route, type AdminRouteDef } from '../shared/route-kit.js';
import { LISTING_SORT, createListingFromLot, listingDetailDto, listingDto, requireListing, soldFromListings } from './listings.service.js';

const minParcelSchema = z.object({ kind: z.enum(['percent', 'quantity']), value: z.number().positive(), unit: z.enum(QUANTITY_UNITS).optional() });

const createBody = z.object({
  lotId: z.string().min(1),
  askPrice: adminUnitPriceSchema,
  priceFloor: adminUnitPriceSchema.optional(),
  quantity: adminQuantitySchema.nullable().optional(),
  minParcel: minParcelSchema.optional(),
  access: z.enum(BUYER_ACCESS).default('all_verified'),
  showAssayToBuyers: z.boolean().default(true),
  featured: z.boolean().optional(),
  note: z.string().max(2000).optional(),
  opensAt: z.string().datetime().nullable().optional(),
  sourceAuctionId: z.string().nullable().optional(),
  draft: z.boolean().default(false),
  confirmBelowCost: z.boolean().optional(),
});

const patchBody = z.object({
  askPrice: adminUnitPriceSchema.optional(),
  priceFloor: adminUnitPriceSchema.nullable().optional(),
  quantity: adminQuantitySchema.optional(),
  minParcel: minParcelSchema.optional(),
  access: z.enum(BUYER_ACCESS).optional(),
  featured: z.boolean().optional(),
  description: z.string().max(4000).optional(),
}).strict();

export const listingRoutes: AdminRouteDef[] = [
  route(38, 'GET /listings/summary', ['vault', 'view'], async (_req, res) => {
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const [live, sold, soldOut] = await Promise.all([Listing.find({ status: 'live' }).lean(), soldFromListings(monthStart), Listing.find({ status: 'sold_out', listedAt: { $exists: true } }).lean()]);
    let catalog = zeroStored();
    for (const l of live) catalog = addStored(catalog, priceTimesQuantity(l.askPrice, l.quantityLeft));
    const soldMinor = sold.filter((s) => s._id === 'USD').reduce((n, s) => n + s.minor, 0);
    const soldPct = soldMinor + catalog.amountMinor > 0 ? Number(((soldMinor / (soldMinor + catalog.amountMinor)) * 100).toFixed(1)) : 0;
    const avgDays = soldOut.length ? Number((soldOut.reduce((n, l) => n + daysBetween(l.listedAt, l.updatedAt), 0) / soldOut.length).toFixed(1)) : 0;
    res.json({
      cards: [
        { key: 'live_listings', label: 'Live listings', value: live.length },
        { key: 'catalog_value', label: 'Catalog value', value: outMoneyOrZero(catalog) },
        { key: 'sold_this_month', label: 'Sold this month', value: outMoneyOrZero({ ...zeroStored(), amountMinor: soldMinor }), sub: `${soldPct}% of listed volume` },
        { key: 'avg_days_to_sell', label: 'Avg days to sell', value: avgDays, unit: 'days' },
      ],
    });
  }),

  route(39, 'GET /listings', ['vault', 'view'], async (req, res) => {
    const status = oneOf(req.query.status, LISTING_STATUSES, 'status');
    const access = oneOf(req.query.access, BUYER_ACCESS, 'access');
    const featured = boolQ(req.query.featured);
    const filter = and(status && { status }, access && { access }, featured !== undefined && { featured }, searchFilter(req.query.q, ['listingId', 'lotId', 'mineral.name', 'grade', 'status', 'access']));
    res.json(await pageOf(Listing, { filter, sort: sortSpec(req, LISTING_SORT, { createdAt: -1, _id: 1 }), paging: paging(req), map: (docs: unknown[]) => docs.map(listingDto) }));
  }),

  route(40, 'POST /listings', ['vault', 'edit'], async (req, res) => {
    const b = req.body as z.infer<typeof createBody>;
    const actor = auditActor(req);
    const { listing, auditId } = await withTx(async (session) => {
      const { listing } = await createListingFromLot(
        {
          lotId: b.lotId,
          askPrice: parseUnitPrice(b.askPrice, 'askPrice'),
          priceFloor: b.priceFloor ? parseUnitPrice(b.priceFloor, 'priceFloor') : undefined,
          quantity: b.quantity ?? null,
          minParcel: b.minParcel,
          access: b.access,
          showAssayToBuyers: b.showAssayToBuyers,
          featured: b.featured,
          note: b.note,
          opensAt: b.opensAt ? new Date(b.opensAt) : null,
          sourceAuctionId: b.sourceAuctionId,
          draft: b.draft,
          confirmBelowCost: b.confirmBelowCost,
          createdBy: actor.staffId,
        },
        session,
      );
      const auditId = await recordAudit({
        actor,
        category: 'vault',
        action: b.draft ? 'Saved listing draft' : 'Published listing',
        record: { type: 'listing', id: listing.listingId, label: listing.listingId },
        after: { lotId: b.lotId, status: listing.status, askPrice: b.askPrice, access: b.access },
        reason: b.note,
        req,
        session,
        activity: b.draft ? undefined : { text: `Listing ${listing.listingId} published for ${b.lotId}`, meta: `${listing.mineral?.name} · ${listing.quantityTotal.value} ${listing.quantityTotal.unit}`, kind: 'listing' },
      });
      return { listing, auditId };
    });
    res.status(201).json(action(await listingDetailDto(listing), b.draft ? 'Listing saved as a draft' : listing.status === 'scheduled' ? 'Listing scheduled for the Buy catalog' : 'Listing published to the Buy catalog', auditId));
  }, { body: createBody }),

  route(41, 'GET /listings/:listingId', ['vault', 'view'], async (req, res) => {
    const l = await requireListing(String(req.params.listingId));
    setEtag(res, docEtag(l));
    res.json(await listingDetailDto(l));
  }),

  route(42, 'PATCH /listings/:listingId', ['vault', 'edit'], async (req, res) => {
    const listingId = String(req.params.listingId);
    const l = await requireListing(listingId);
    assertIfMatch(req, docEtag(l));
    const b = req.body as z.infer<typeof patchBody>;
    const set: Record<string, unknown> = {};
    const ask = b.askPrice ? parseUnitPrice(b.askPrice, 'askPrice') : l.askPrice;
    if (b.askPrice) set.askPrice = ask;
    let floor = l.priceFloor;
    if (b.priceFloor === null) { set.priceFloor = undefined; floor = undefined; }
    else if (b.priceFloor) { floor = parseUnitPrice(b.priceFloor, 'priceFloor'); set.priceFloor = floor; }
    if (floor && ask && floor.per === ask.per && floor.amountMinor > ask.amountMinor) {
      throw new AppError({ status: 422, code: 'rule/floor-above-ask', message: 'Price floor cannot be above the ask price.', fields: { priceFloor: 'Must not exceed ask price' } });
    }
    if (b.quantity) {
      const unit = l.quantityTotal.unit as QuantityUnit;
      const newTotal = convertQty(b.quantity.value, b.quantity.unit, unit);
      const sold = l.quantityTotal.value - l.quantityLeft.value;
      if (newTotal + 1e-9 < sold) throw new AppError({ status: 422, code: 'rule/quantity-below-sold', message: `Quantity cannot be below what is already sold (${sold} ${unit}).`, fields: { quantity: 'Below sold quantity' } });
      const lot = await VaultLot.findOne({ lotId: l.lotId }).lean();
      const lotCap = lot ? convertQty(lot.quantity.value, lot.quantity.unit, unit) : Infinity;
      if (newTotal > lotCap + 1e-9) throw new AppError({ status: 422, code: 'rule/quantity-exceeds-lot', message: 'Quantity exceeds the source lot.', fields: { quantity: 'Exceeds lot quantity' } });
      set.quantityTotal = { value: newTotal, unit };
      set.quantityLeft = { value: Number((newTotal - sold).toFixed(6)), unit };
    }
    for (const k of ['minParcel', 'access', 'featured', 'description'] as const) if (b[k] !== undefined) set[k] = b[k];
    const actor = auditActor(req);

    const { updated, auditId } = await withTx(async (session) => {
      const updated = await Listing.findOneAndUpdate({ _id: l._id, __v: l.__v }, { $set: set, $inc: { __v: 1 } }, { new: true, session }).lean();
      if (!updated) throw new AppError({ status: 412, code: 'conflict/etag-mismatch', message: 'Someone else changed this — reload and try again.' });
      const auditId = await recordAudit({
        actor,
        category: 'vault',
        action: 'Edited listing configuration',
        record: { type: 'listing', id: listingId, label: listingId },
        before: { askPrice: l.askPrice && { amountMinor: l.askPrice.amountMinor }, access: l.access, featured: l.featured, quantityTotal: l.quantityTotal },
        after: b,
        req,
        session,
      });
      return { updated, auditId };
    });
    setEtag(res, docEtag(updated));
    res.json({ ...(await listingDetailDto(updated)), auditId });
  }, { body: patchBody }),

  route(43, 'POST /listings/:listingId/pause', ['vault', 'edit'], async (req, res) => {
    res.json(await transition(req, 'pause'));
  }, { body: z.object({ reason: z.string().max(500).optional() }).default({}) }),

  route(44, 'POST /listings/:listingId/resume', ['vault', 'edit'], async (req, res) => {
    res.json(await transition(req, 'resume'));
  }, { body: z.object({ reason: z.string().max(500).optional() }).default({}) }),

  route(45, 'POST /listings/:listingId/end', ['vault', 'edit'], async (req, res) => {
    const listingId = String(req.params.listingId);
    const { returnLotTo } = req.body as { returnLotTo: 'reserve' | 'vault' };
    const l = await requireListing(listingId);
    if (!['live', 'paused', 'scheduled', 'draft'].includes(l.status)) {
      throw conflict('conflict/stale-state', `${listingId} is already ${l.status.replace('_', ' ')}.`, { details: { status: l.status } });
    }
    const actor = auditActor(req);
    const now = new Date();
    const { updated, auditId } = await withTx(async (session) => {
      const updated = await Listing.findOneAndUpdate({ listingId, status: { $in: ['live', 'paused', 'scheduled', 'draft'] } }, { $set: { status: 'ended', endedAt: now } }, { new: true, session }).lean();
      if (!updated) throw conflict('conflict/stale-state', `${listingId} changed state — refresh and try again.`);
      // Only the unsold quantity returns to the lot.
      const lot = await VaultLot.findOne({ lotId: l.lotId }, null, { session }).lean();
      if (lot && l.status !== 'draft') {
        const remaining = convertQty(l.quantityLeft.value, l.quantityLeft.unit as QuantityUnit, lot.quantity.unit as QuantityUnit);
        const back = remaining <= 1e-9 ? { status: 'shipped' } : returnLotTo === 'vault' ? { status: 'in_vault' } : { status: 'reserved', hold: { reason: `Listing ${listingId} ended`, reviewOn: new Date(now.getTime() + 14 * 86_400_000).toISOString().slice(0, 10), visibleInUnallocatedQueue: true, heldBy: actor.staffId, at: now } };
        await VaultLot.updateOne(
          { lotId: l.lotId },
          { $set: { ...back, quantity: { value: Number(remaining.toFixed(6)), unit: lot.quantity.unit } }, $unset: { listingId: 1 }, $push: { allocationHistory: { title: 'Listing ended', sub: `${listingId} · ${remaining.toFixed(2)} ${lot.quantity.unit} returned`, date: now } } },
          { session },
        );
      }
      const auditId = await recordAudit({ actor, category: 'vault', action: 'Ended listing', record: { type: 'listing', id: listingId, label: listingId }, before: { status: l.status }, after: { status: 'ended', returnLotTo }, req, session, activity: { text: `Listing ${listingId} ended`, meta: `Lot ${l.lotId} returned to vault ${returnLotTo}`, kind: 'listing' } });
      return { updated, auditId };
    });
    res.json(action(await listingDetailDto(updated), `${listingId} ended — lot returned to vault ${returnLotTo === 'vault' ? '' : 'reserve'}`.trim(), auditId));
  }, { body: z.object({ returnLotTo: z.enum(['reserve', 'vault']).default('reserve') }).default({}) }),
];

async function transition(req: import('express').Request, kind: 'pause' | 'resume') {
  const listingId = String(req.params.listingId);
  const l = await requireListing(listingId);
  const from = kind === 'pause' ? 'live' : 'paused';
  const to = kind === 'pause' ? 'paused' : 'live';
  if (l.status !== from) throw conflict('conflict/stale-state', `${listingId} is ${l.status.replace('_', ' ')} — cannot ${kind}.`, { details: { status: l.status } });
  const actor = auditActor(req);
  const { updated, auditId } = await withTx(async (session) => {
    const updated = await Listing.findOneAndUpdate({ listingId, status: from }, { $set: { status: to } }, { new: true, session }).lean();
    if (!updated) throw conflict('conflict/stale-state', `${listingId} changed state — refresh and try again.`);
    const auditId = await recordAudit({ actor, category: 'vault', action: kind === 'pause' ? 'Paused listing' : 'Resumed listing', record: { type: 'listing', id: listingId, label: listingId }, before: { status: from }, after: { status: to }, reason: req.body?.reason, req, session });
    return { updated, auditId };
  });
  return action(await listingDetailDto(updated), kind === 'pause' ? `${listingId} paused — hidden from buyers` : `${listingId} resumed — visible in the catalog`, auditId);
}
