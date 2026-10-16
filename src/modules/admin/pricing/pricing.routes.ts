import { z } from 'zod';
import { AppError, conflict, notFound, unprocessable } from '../../../common/errors/app-error.js';
import { loadEnv } from '../../../config/env.js';
import { withTx } from '../../../common/db/transaction.js';
import { Offer, Order, Rate, RateHistory } from '../../../models/trading.models.js';
import { assertFourEyes, auditActor } from '../shared/staff-context.js';
import { recordAudit } from '../../audit/audit.service.js';
import { MS_HOUR } from '../shared/enums.js';
import { action, and, escapeRegex, iso, oneOf, pageOf, paging, sendCsv, sortSpec, toCsv, isoDate, searchFilter } from '../shared/http.js';
import { sendCustomerMessage } from '../shared/messaging.js';
import { adminMoneySchema, adminUnitPriceSchema, pctChange, formatMoneyText, outMoney, outQty, outUnitPrice, parsePositiveMoney, parseUnitPrice, type StoredUnitPrice } from '../shared/money.js';
import { loadUserMap, partyFrom } from '../shared/refs.js';
import { route, type AdminRouteDef } from '../shared/route-kit.js';
import { getPlatformValues } from '../settings/settings.service.js';

const RATE_SORT: Record<string, string> = { mineral: 'mineral', buy: 'buy.amountMinor', sell: 'sell.amountMinor', trend: 'trend24hPct' };
const FEED_SYNC_SECONDS = 120;

export function rateDto(r: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
  return { id: r.rateId, mineral: r.mineral, grade: r.grade, buy: outUnitPrice(r.buy), sell: outUnitPrice(r.sell), source: r.source, updatedAt: iso(r.updatedAt), trend24hPct: r.trend24hPct ?? 0 };
}

async function requireRate(rateId: string) {
  const r = await Rate.findOne({ rateId }).lean();
  if (!r) throw notFound('resource/not-found', `Rate ${rateId} not found`);
  return r;
}

const RANGE_DAYS: Record<string, number> = { '12W': 84, '6M': 183, '1Y': 365 };

const decisionBody = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve') }),
  z.object({ decision: z.literal('adjust'), amount: adminMoneySchema, reason: z.string().trim().min(3, 'Give a reason for the adjustment').max(1000) }),
  z.object({ decision: z.literal('hold'), reason: z.string().trim().min(3, 'Give a reason for the hold').max(1000) }),
]);

export const pricingRoutes: AdminRouteDef[] = [
  route(46, 'GET /pricing/feed-status', ['pricing', 'view'], async (_req, res) => {
    const env = loadEnv();
    const latest = await Rate.findOne({ feedSyncedAt: { $exists: true } }).sort({ feedSyncedAt: -1 }).lean();
    const last = latest?.feedSyncedAt as Date | undefined;
    const ageSec = last ? (Date.now() - last.getTime()) / 1000 : Infinity;
    const state = !env.RATE_FEED_PROVIDER ? 'down' : ageSec < 600 ? 'live' : ageSec < 3600 ? 'degraded' : 'down';
    res.json({
      state,
      provider: env.RATE_FEED_PROVIDER ?? 'unconfigured',
      lastSyncAt: iso(last),
      nextSyncAt: last ? new Date(last.getTime() + FEED_SYNC_SECONDS * 1000).toISOString() : null,
      ...(!env.RATE_FEED_PROVIDER ? { note: 'RATE_FEED_PROVIDER is not configured; rates only change via manual override.' } : {}),
    });
  }),

  route(47, 'GET /pricing/rates', ['pricing', 'view'], async (req, res) => {
    const source = oneOf(req.query.source, ['market_feed', 'manual_override'] as const, 'source');
    const mineral = typeof req.query.mineral === 'string' && req.query.mineral ? req.query.mineral : undefined;
    const filter = and(source && { source }, mineral && { mineral: new RegExp(`^${escapeRegex(mineral)}$`, 'i') }, searchFilter(req.query.q, ['mineral', 'grade', 'source']));
    res.json(await pageOf(Rate, { filter, sort: sortSpec(req, RATE_SORT, { mineral: 1, grade: 1 }), paging: paging(req, 100), map: (docs: unknown[]) => docs.map(rateDto) }));
  }),

  route(48, 'GET /pricing/rates/export', ['pricing', 'view'], async (req, res) => {
    const source = oneOf(req.query.source, ['market_feed', 'manual_override'] as const, 'source');
    const rates = await Rate.find(and(source && { source }, searchFilter(req.query.q, ['mineral', 'grade', 'source']))).sort({ mineral: 1, grade: 1 }).lean();
    sendCsv(res, `rates-${isoDate()}.csv`, toCsv(['rate_id', 'mineral', 'grade', 'buy', 'sell', 'currency', 'per', 'source', 'trend_24h_pct', 'updated_at'], rates.map((r) => [r.rateId, r.mineral, r.grade, outUnitPrice(r.buy)?.amount, outUnitPrice(r.sell)?.amount, r.buy?.currency, r.buy?.per, r.source, r.trend24hPct, r.updatedAt])));
  }),

  route(49, 'GET /pricing/rates/:rateId/history', ['pricing', 'view'], async (req, res) => {
    const q = z.object({ range: z.enum(['12W', '6M', '1Y']).default('12W'), side: z.enum(['buy', 'sell']).default('buy') }).parse(req.query);
    const rate = await requireRate(String(req.params.rateId));
    const from = new Date(Date.now() - RANGE_DAYS[q.range]! * 86_400_000);
    const rows = await RateHistory.find({ rateId: rate.rateId, at: { $gte: from } }).sort({ at: 1 }).lean();
    const field = q.side === 'buy' ? 'buyMinor' : 'sellMinor';
    const points = rows.map((r) => ({ at: isoDate(r.at), value: Number(((r[field] as number) / 10 ** (r.scale ?? 2)).toFixed(r.scale ?? 2)) }));
    const values = points.map((p) => p.value);
    res.json({
      rateId: rate.rateId,
      range: q.range,
      side: q.side,
      points,
      summary: values.length ? { start: values[0], high: Math.max(...values), low: Math.min(...values), changePct: pctChange(values[0]!, values[values.length - 1]!) } : { start: 0, high: 0, low: 0, changePct: 0 },
      unit: rate.buy?.per ?? 'kg',
      currency: rate.buy?.currency ?? 'USD',
    });
  }),

  route(50, 'PUT /pricing/rates/:rateId/source', ['pricing', 'edit'], async (req, res) => {
    const rateId = String(req.params.rateId);
    const b = req.body as { source: 'market_feed' | 'manual_override'; buy?: { amount: number; currency: string; per: 'kg' | 't' | 'g' | 'oz' }; sell?: { amount: number; currency: string; per: 'kg' | 't' | 'g' | 'oz' }; reason?: string; confirmDeviation?: boolean };
    const r = await requireRate(rateId);
    const actor = auditActor(req);
    const set: Record<string, unknown> = { source: b.source };
    let message: string;
    if (b.source === 'manual_override') {
      const buy: StoredUnitPrice = b.buy ? parseUnitPrice(b.buy, 'buy') : r.feedBuy;
      const sell: StoredUnitPrice = b.sell ? parseUnitPrice(b.sell, 'sell') : r.feedSell;
      if (buy.amountMinor <= 0 || sell.amountMinor <= 0) throw unprocessable('Rates must be greater than 0', { buy: 'Must be greater than 0' });
      if (sell.amountMinor < buy.amountMinor) throw unprocessable('Sell rate cannot be below the buy rate', { sell: 'Must be ≥ buy' });
      const limit = (await getPlatformValues()).rate_override_max_deviation_pct!;
      const dev = Math.max(Math.abs(pctChange(r.feedBuy.amountMinor, buy.amountMinor)), Math.abs(pctChange(r.feedSell.amountMinor, sell.amountMinor)));
      if (dev > limit && !b.confirmDeviation) {
        throw new AppError({ status: 422, code: 'rule/override-deviation', message: `Manual rate is ${dev.toFixed(1)}% from the feed (limit ±${limit}%). Confirm to continue.`, details: { deviationPct: dev, limitPct: limit } });
      }
      Object.assign(set, { buy, sell, overrideReason: b.reason, overriddenBy: actor.staffId });
      message = `${r.mineral} ${r.grade} switched to manual desk rate`.replace(/\s+/g, ' ');
    } else {
      Object.assign(set, { buy: r.feedBuy, sell: r.feedSell, overrideReason: null, overriddenBy: null });
      message = `${r.mineral} ${r.grade} switched back to market feed`.replace(/\s+/g, ' ');
    }
    const now = new Date();
    const { updated, auditId } = await withTx(async (session) => {
      const updated = await Rate.findOneAndUpdate({ rateId }, { $set: set }, { new: true, session }).lean();
      const eff = updated!;
      await RateHistory.create([{ rateId, at: now, buyMinor: eff.buy.amountMinor, sellMinor: eff.sell.amountMinor, currency: eff.buy.currency, scale: eff.buy.scale, per: eff.buy.per }], { session });
      const auditId = await recordAudit({
        actor,
        category: 'pricing',
        action: b.source === 'manual_override' ? 'Switched rate to manual desk override' : 'Switched rate back to market feed',
        record: { type: 'rate', id: rateId, label: `${r.mineral} ${r.grade}`.trim() },
        before: { source: r.source, buy: outUnitPrice(r.buy), sell: outUnitPrice(r.sell) },
        after: { source: b.source, buy: outUnitPrice(eff.buy), sell: outUnitPrice(eff.sell) },
        reason: b.reason,
        req,
        session,
        activity: { text: message, meta: b.reason, kind: 'rate' },
      });
      return { updated, auditId };
    });
    res.json(action(rateDto(updated), message, auditId));
  }, {
    body: z.object({
      source: z.enum(['market_feed', 'manual_override']),
      buy: adminUnitPriceSchema.optional(),
      sell: adminUnitPriceSchema.optional(),
      reason: z.string().max(500).optional(),
      confirmDeviation: z.boolean().optional(),
    }),
  }),

  route(51, 'GET /pricing/offers', ['pricing', 'view'], async (req, res) => {
    const status = oneOf(req.query.status, ['pending', 'held', 'approved', 'adjusted', 'sent'] as const, 'status') ?? 'pending';
    const filter = and({ status }, searchFilter(req.query.q, ['offerId', 'orderId', 'mineral.name', 'note']));
    res.json(
      await pageOf(Offer, {
        filter,
        sort: { createdAt: 1, _id: 1 },
        paging: paging(req),
        map: async (docs: any[]) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          const users = await loadUserMap(docs.map((d) => d.userId));
          return docs.map((o) => offerDto(o, partyFrom(users, o.userId)));
        },
      }),
    );
  }),

  // #52 — money-moving: Idempotency-Key required + four-eyes.
  route(52, 'POST /pricing/offers/:offerId/decision', ['pricing', 'edit'], async (req, res) => {
    const offerId = String(req.params.offerId);
    const b = req.body as z.infer<typeof decisionBody>;
    const offer = await Offer.findOne({ offerId }).lean();
    if (!offer) throw notFound('resource/not-found', `Offer ${offerId} not found`);
    assertFourEyes(req, [offer.createdBy]);
    if (!['pending', 'held'].includes(offer.status)) {
      throw conflict('conflict/stale-state', `${offerId} was already ${offer.status}.`, { details: { status: offer.status } });
    }
    const actor = auditActor(req);
    const now = new Date();
    const [user] = await Promise.all([loadUserMap([offer.userId])]);
    const party = partyFrom(user, offer.userId)!;
    const platform = await getPlatformValues();
    const validityHours = offer.validityHours ?? platform.firm_offer_validity_hours!;

    let status: 'approved' | 'adjusted' | 'held';
    let amount = offer.suggested;
    let reason: string | undefined;
    if (b.decision === 'approve') status = 'approved';
    else if (b.decision === 'adjust') {
      status = 'adjusted';
      amount = parsePositiveMoney(b.amount, 'amount');
      if (offer.suggested && offer.suggested.currency !== amount.currency) throw unprocessable('Currency mismatch', { amount: `Use ${offer.suggested.currency}` });
      reason = b.reason;
    } else {
      status = 'held';
      reason = b.reason;
    }
    const sentAt = status === 'held' ? undefined : now;
    const expiresAt = status === 'held' ? undefined : new Date(now.getTime() + validityHours * MS_HOUR);

    const { updated, auditId } = await withTx(async (session) => {
      const updated = await Offer.findOneAndUpdate(
        { offerId, status: { $in: ['pending', 'held'] } },
        { $set: { status, amount: status === 'held' ? undefined : amount, decisionReason: reason, decidedBy: actor.staffId, decidedAt: now, sentAt, expiresAt } },
        { new: true, session },
      ).lean();
      if (!updated) throw conflict('conflict/stale-state', `${offerId} was already decided.`);
      await Order.updateOne({ orderId: offer.orderId }, { $push: { history: { text: status === 'held' ? 'Firm offer held for desk review' : `Firm offer ${status === 'adjusted' ? 'adjusted and ' : ''}sent (${formatMoneyText(outMoney(amount))})`, actorId: actor.staffId, at: now } } }, { session });
      if (status !== 'held') {
        await sendCustomerMessage({ userId: offer.userId, subject: `Firm offer for ${offer.orderId}`, body: `Your firm offer is ${formatMoneyText(outMoney(amount))}, valid for ${validityHours} hours.`, channels: ['in_app'], related: { type: 'order', id: offer.orderId }, sentBy: actor.staffId, session }).catch(() => undefined);
      }
      const auditId = await recordAudit({
        actor,
        category: 'pricing',
        action: status === 'held' ? 'Held firm offer for review' : status === 'adjusted' ? 'Adjusted and approved firm offer' : 'Approved firm offer',
        record: { type: 'offer', id: offerId, label: `${offer.orderId} offer` },
        before: { status: offer.status, suggested: outMoney(offer.suggested) },
        after: { status, amount: outMoney(status === 'held' ? undefined : amount), orderId: offer.orderId },
        reason,
        req,
        session,
        activity: { text: `Offer ${offerId} ${status} for ${offer.orderId}`, meta: party.org ?? party.name, kind: 'offer', ref: { type: 'order', id: offer.orderId } },
      });
      return { updated, auditId };
    });
    const message =
      status === 'approved' ? `Firm offer ${formatMoneyText(outMoney(amount))} sent to ${party.org ?? party.name}`
      : status === 'adjusted' ? `Adjusted offer sent to ${party.org ?? party.name} for ${offer.orderId}`
      : `${offer.orderId} held for desk review`;
    res.json(action({ ...offerDto(updated, party), status, ...(sentAt ? { sentAt: sentAt.toISOString() } : {}), ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}) }, message, auditId));
  }, { idem: 'required', body: decisionBody }),
];

function offerDto(o: any, party: unknown) { // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    id: o.offerId,
    orderId: o.orderId,
    party,
    mineral: o.mineral?.name,
    declared: outQty(o.declared),
    assayed: outQty(o.assayed),
    assay: { grade: o.assay?.grade ?? '', certificateNo: o.assay?.certificateNo ?? '', ...(o.assay?.fileId ? { fileId: o.assay.fileId } : {}) },
    rateApplied: outUnitPrice(o.rateApplied),
    suggested: outMoney(o.suggested),
    note: o.note ?? '',
    noteKind: o.noteKind,
    validityHours: o.validityHours,
    status: o.status,
    ...(o.amount ? { amount: outMoney(o.amount) } : {}),
  };
}
