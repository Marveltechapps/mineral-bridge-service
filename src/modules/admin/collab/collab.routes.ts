import { z } from 'zod';
import { AppError, conflict, notFound } from '../../../common/errors/app-error.js';
import { loadEnv } from '../../../config/env.js';
import { nextId } from '../../../common/db/sequence.js';
import { withTx } from '../../../common/db/transaction.js';
import { Contract, Negotiation } from '../../../models/finance.models.js';
import { Order } from '../../../models/trading.models.js';
import { Dispute, User } from '../../../models/people.models.js';
import { recordAudit } from '../../audit/audit.service.js';
import { auditActor } from '../shared/staff-context.js';
import { NEGOTIATION_STATUSES, MS_DAY, MS_HOUR } from '../shared/enums.js';
import { action, and, boolQ, dateQ, escapeRegex, iso, oneOf, pageOf, paging, searchFilter } from '../shared/http.js';
import { sendCustomerMessage } from '../shared/messaging.js';
import { addStored, adminUnitPriceSchema, formatMoneyText, outMoney, outMoneyOrZero, outQty, outUnitPrice, parseUnitPrice, priceTimesQuantity, zeroStored } from '../shared/money.js';
import { loadUserMap, partyFrom } from '../shared/refs.js';
import { route, type AdminRouteDef } from '../shared/route-kit.js';

const REMINDER_COOLDOWN_MS = 12 * MS_HOUR;
const TERMINAL = ['terms_agreed', 'contracted'];

function negotiationDto(n: Record<string, any>, users: Map<string, any>, withHistory = false) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const ask = n.ask?.amountMinor ?? 0;
  const gap = ask ? Number((((ask - (n.offer?.amountMinor ?? 0)) / ask) * 100).toFixed(1)) : 0;
  return {
    id: n.negotiationId,
    miner: partyFrom(users, n.minerId),
    trader: partyFrom(users, n.traderId),
    goods: n.goods ?? '',
    quantity: outQty(n.quantity),
    ask: outUnitPrice(n.ask),
    offer: outUnitPrice(n.offer),
    gapPct: gap,
    rounds: n.rounds ?? 1,
    status: n.status,
    lastActivityAt: iso(n.lastActivityAt),
    ...(withHistory
      ? {
          history: (n.history ?? []).map((h: Record<string, any>) => ({ round: h.round, side: h.side, price: outUnitPrice(h.price), at: iso(h.at) })), // eslint-disable-line @typescript-eslint/no-explicit-any
          suggestedMidpoint: n.ask && n.offer ? outUnitPrice({ ...n.ask, amountMinor: Math.round((n.ask.amountMinor + n.offer.amountMinor) / 2) }) : null,
        }
      : {}),
  };
}

export function contractDto(c: Record<string, any>, users: Map<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  return { id: c.contractId, seller: partyFrom(users, c.sellerId), buyer: partyFrom(users, c.buyerId), goods: c.goods ?? '', value: outMoney(c.value), signedAt: iso(c.signedAt), lcId: c.lcId || null, negotiationId: c.negotiationId ?? '' };
}

async function requireNegotiation(id: string) {
  const n = await Negotiation.findOne({ negotiationId: id }).lean();
  if (!n) throw notFound('resource/not-found', `Negotiation ${id} not found`);
  return n;
}

async function userIdsMatching(q: unknown): Promise<string[]> {
  if (typeof q !== 'string' || !q.trim()) return [];
  const re = new RegExp(escapeRegex(q.trim()), 'i');
  return (await User.find({ $or: [{ name: re }, { org: re }] }).limit(50).lean()).map((u) => u.userId);
}

/** Marks a pending contract signed (called by the e-signature provider webhook / worker). */
export async function markContractSigned(contractId: string, at = new Date()) {
  return Contract.findOneAndUpdate({ contractId, status: 'pending_signature' }, { $set: { status: 'signed', signedAt: at, 'signature.status': 'completed' } }, { new: true }).lean();
}

export const collabRoutes: AdminRouteDef[] = [
  route(74, 'GET /negotiations/summary', ['orders', 'view'], async (_req, res) => {
    const now = new Date();
    const qStart = new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1));
    const since = new Date(now.getTime() - 90 * MS_DAY);
    const [active, awaiting, contracts, agreed, recent] = await Promise.all([
      Negotiation.countDocuments({ status: { $ne: 'contracted' } }),
      Negotiation.countDocuments({ status: { $in: ['awaiting_miner', 'awaiting_trader'] } }),
      Contract.find({ status: 'signed', signedAt: { $gte: qStart } }).select('value').lean(),
      Negotiation.find({ agreedAt: { $gte: since } }).select('openedAt agreedAt').lean(),
      Negotiation.countDocuments({ openedAt: { $gte: since } }),
    ]);
    let value = zeroStored();
    for (const c of contracts) if (c.value) value = addStored(value, c.value);
    const avgDays = agreed.length ? agreed.reduce((n, a) => n + (a.agreedAt.getTime() - a.openedAt.getTime()) / MS_DAY, 0) / agreed.length : 0;
    const accepted = await Negotiation.countDocuments({ openedAt: { $gte: since }, status: { $in: ['terms_agreed', 'contracted'] } });
    res.json({
      cards: [
        { key: 'active', label: 'Active negotiations', value: active, sub: `${awaiting} awaiting a counter-offer` },
        { key: 'contracts_qtd', label: 'Contracts QTD', value: contracts.length, sub: formatMoneyText(outMoneyOrZero(value)) },
        { key: 'avg_time_to_agreement', label: 'Avg time to agreement', value: Number(avgDays.toFixed(1)), unit: 'days' },
        { key: 'offer_acceptance_rate', label: 'Offer acceptance rate', value: recent ? Number(((accepted / recent) * 100).toFixed(1)) : 0, unit: '%' },
      ],
    });
  }),

  route(75, 'GET /negotiations', ['orders', 'view'], async (req, res) => {
    const status = oneOf(req.query.status, NEGOTIATION_STATUSES, 'status');
    let search = searchFilter(req.query.q, ['negotiationId', 'goods', 'status']);
    const ids = await userIdsMatching(req.query.q);
    if (ids.length) search = { $or: [...((search as { $or: unknown[] } | null)?.$or ?? []), { minerId: { $in: ids } }, { traderId: { $in: ids } }] };
    res.json(
      await pageOf(Negotiation, {
        filter: and(status && { status }, search),
        sort: { lastActivityAt: -1, _id: 1 },
        paging: paging(req),
        map: async (docs: any[]) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          const users = await loadUserMap(docs.flatMap((d) => [d.minerId, d.traderId]));
          return docs.map((d) => negotiationDto(d, users));
        },
      }),
    );
  }),

  route(76, 'GET /negotiations/:negotiationId', ['orders', 'view'], async (req, res) => {
    const n = await requireNegotiation(String(req.params.negotiationId));
    res.json(negotiationDto(n, await loadUserMap([n.minerId, n.traderId]), true));
  }),

  route(77, 'POST /negotiations/:negotiationId/mediations', ['orders', 'edit'], async (req, res) => {
    const negotiationId = String(req.params.negotiationId);
    const b = req.body as { price: { amount: number; currency: string; per: 'kg' | 't' | 'g' | 'oz' }; validForHours: number; note?: string; draft: boolean };
    const n = await requireNegotiation(negotiationId);
    if (TERMINAL.includes(n.status)) throw conflict('conflict/stale-state', `${negotiationId} is already ${n.status.replace('_', ' ')}.`, { details: { status: n.status } });
    const price = parseUnitPrice(b.price, 'price');
    if (price.amountMinor <= 0) throw new AppError({ status: 422, code: 'validation/invalid', message: 'Price must be greater than 0', fields: { price: 'Must be greater than 0' } });
    const actor = auditActor(req);
    const now = new Date();
    const { updated, auditId } = await withTx(async (session) => {
      const updated = await Negotiation.findOneAndUpdate(
        { negotiationId, status: { $nin: TERMINAL } },
        { $push: { mediations: { price, validForHours: b.validForHours, note: b.note, by: actor.staffId, at: now, draft: b.draft } }, ...(b.draft ? {} : { $set: { lastActivityAt: now } }) },
        { new: true, session },
      ).lean();
      if (!updated) throw conflict('conflict/stale-state', `${negotiationId} changed state — refresh and try again.`);
      const auditId = await recordAudit({ actor, category: 'orders', action: b.draft ? 'Saved mediated price draft' : 'Sent mediated price', record: { type: 'negotiation', id: negotiationId, label: negotiationId }, after: { price: b.price, validForHours: b.validForHours }, reason: b.note, req, session, activity: b.draft ? undefined : { text: `Mediated offer sent on ${negotiationId}`, meta: formatMoneyText(outMoney(price)) + `/${price.per}`, kind: 'negotiation' } });
      return { updated, auditId };
    });
    if (!b.draft) {
      const text = `Mineral Bridge suggests ${formatMoneyText(outMoney(price))}/${price.per} for ${n.goods}. Valid for ${b.validForHours} hours.${b.note ? ` ${b.note}` : ''}`;
      await Promise.all([n.minerId, n.traderId].map((userId) => sendCustomerMessage({ userId, subject: `Mediated offer on ${negotiationId}`, body: text, channels: ['in_app'], related: { type: 'negotiation', id: negotiationId }, sentBy: actor.staffId }).catch(() => undefined)));
    }
    res.status(201).json(action(negotiationDto(updated, await loadUserMap([n.minerId, n.traderId])), b.draft ? `Mediation draft saved on ${negotiationId}` : `Mediated offer sent on ${negotiationId}`, auditId));
  }, { body: z.object({ price: adminUnitPriceSchema, validForHours: z.number().int().min(1).max(168).default(48), note: z.string().trim().max(500).optional(), draft: z.boolean().default(false) }) }),

  route(78, 'POST /negotiations/:negotiationId/reminders', ['orders', 'edit'], async (req, res) => {
    const negotiationId = String(req.params.negotiationId);
    const n = await requireNegotiation(negotiationId);
    if (n.status !== 'awaiting_miner' && n.status !== 'awaiting_trader') throw conflict('conflict/stale-state', `${negotiationId} is not waiting on a counter-offer.`, { details: { status: n.status } });
    const toId = n.status === 'awaiting_miner' ? n.minerId : n.traderId;
    const actor = auditActor(req);
    const now = new Date();
    const cutoff = new Date(now.getTime() - REMINDER_COOLDOWN_MS);
    const claimed = await Negotiation.findOneAndUpdate(
      { negotiationId, status: n.status, reminders: { $not: { $elemMatch: { to: toId, at: { $gt: cutoff } } } } },
      { $push: { reminders: { to: toId, by: actor.staffId, at: now } } },
      { new: true },
    ).lean();
    if (!claimed) {
      const last = [...(n.reminders ?? [])].filter((r: { to: string }) => r.to === toId).sort((a: { at: Date }, b: { at: Date }) => b.at.getTime() - a.at.getTime())[0];
      const retryAfter = last ? Math.max(1, Math.ceil((last.at.getTime() + REMINDER_COOLDOWN_MS - now.getTime()) / 1000)) : 1;
      throw new AppError({ status: 429, code: 'rate-limited', message: 'A reminder was already sent in the last 12 hours.', details: { retryAfterSeconds: retryAfter } });
    }
    const users = await loadUserMap([toId]);
    const party = partyFrom(users, toId)!;
    await sendCustomerMessage({ userId: toId, subject: `Reminder: ${negotiationId}`, body: `${n.goods}: the other party is waiting for your counter-offer.`, channels: ['in_app', 'sms'], related: { type: 'negotiation', id: negotiationId }, sentBy: actor.staffId });
    await recordAudit({ actor, category: 'orders', action: 'Sent negotiation reminder', record: { type: 'negotiation', id: negotiationId, label: negotiationId }, after: { to: toId }, req });
    res.json({ sentTo: party, message: `Reminder sent to ${party.org || party.name}` });
  }, { body: z.object({}).passthrough().default({}) }),

  route(79, 'POST /negotiations/:negotiationId/contract', ['orders', 'edit'], async (req, res) => {
    const negotiationId = String(req.params.negotiationId);
    const b = req.body as { templateId?: string; requireLc: boolean };
    const n = await requireNegotiation(negotiationId);
    if (n.status === 'contracted') throw conflict('conflict/duplicate', `${negotiationId} already has a contract (${n.contractId}).`);
    if (n.status !== 'terms_agreed' || !n.agreedPrice) throw new AppError({ status: 422, code: 'rule/terms-not-agreed', message: 'Both parties must agree terms before a contract can be drafted.' });
    const actor = auditActor(req);
    const provider = loadEnv().ESIGN_PROVIDER ?? 'internal';
    const now = new Date();
    const { contract, auditId } = await withTx(async (session) => {
      const claimed = await Negotiation.findOneAndUpdate({ negotiationId, status: 'terms_agreed' }, { $set: { status: 'contracted' } }, { new: true, session }).lean();
      if (!claimed) throw conflict('conflict/stale-state', `${negotiationId} changed state — refresh and try again.`);
      const contractId = await nextId('contract', session);
      const envelopeId = `ENV-${contractId}`;
      const value = priceTimesQuantity(n.agreedPrice, n.quantity);
      const [created] = await Contract.create(
        [{ contractId, sellerId: n.minerId, buyerId: n.traderId, goods: n.goods, value, status: 'pending_signature', requireLc: b.requireLc, negotiationId, templateId: b.templateId, signature: { provider, envelopeId, status: 'sent' }, createdBy: actor.staffId }],
        { session },
      );
      await Negotiation.updateOne({ negotiationId }, { $set: { contractId, lastActivityAt: now } }, { session });
      const auditId = await recordAudit({ actor, category: 'orders', action: 'Converted negotiation to contract', record: { type: 'contract', id: contractId, label: contractId }, after: { negotiationId, value: outMoney(value), requireLc: b.requireLc, provider }, req, session, activity: { text: `Contract ${contractId} drafted from ${negotiationId}`, meta: formatMoneyText(outMoney(value)), kind: 'contract' } });
      return { contract: created.toObject(), auditId };
    });
    await Promise.all([n.minerId, n.traderId].map((userId) => sendCustomerMessage({ userId, subject: `Contract ${contract.contractId} ready to sign`, body: `Your contract for ${n.goods} has been sent for e-signature.`, channels: ['in_app'], related: { type: 'contract', id: contract.contractId }, sentBy: actor.staffId }).catch(() => undefined)));
    const users = await loadUserMap([contract.sellerId, contract.buyerId]);
    res.status(201).json(action({ ...contractDto(contract, users), signature: { provider, envelopeId: contract.signature.envelopeId, status: 'sent' as const } }, `Contract drafted for ${negotiationId} — sent to both parties for e-signature`, auditId));
  }, { body: z.object({ templateId: z.string().optional(), requireLc: z.boolean().default(true) }).default({}) }),

  route(80, 'GET /contracts', ['orders', 'view'], async (req, res) => {
    const withoutLc = boolQ(req.query.withoutLc);
    const signedFrom = dateQ(req.query.signedFrom, 'signedFrom');
    let search = searchFilter(req.query.q, ['contractId', 'goods', 'negotiationId']);
    const ids = await userIdsMatching(req.query.q);
    if (ids.length) search = { $or: [...((search as { $or: unknown[] } | null)?.$or ?? []), { sellerId: { $in: ids } }, { buyerId: { $in: ids } }] };
    const noLc = withoutLc ? { $or: [{ lcId: { $exists: false } }, { lcId: null }, { lcId: '' }] } : null;
    res.json(
      await pageOf(Contract, {
        filter: and({ status: 'signed' }, signedFrom && { signedAt: { $gte: signedFrom } }, noLc, search),
        sort: { signedAt: -1, _id: 1 },
        paging: paging(req),
        map: async (docs: any[]) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          const users = await loadUserMap(docs.flatMap((d) => [d.sellerId, d.buyerId]));
          return docs.map((d) => contractDto(d, users));
        },
      }),
    );
  }),

  // Ratings are derived, not stored: deals = completed orders, on-time = share without a hold exception,
  // rating = 5 minus penalties for disputes and held orders (1.0–5.0).
  route(81, 'GET /network/rankings', ['orders', 'view'], async (req, res) => {
    const role = oneOf(req.query.role, ['miner', 'trader'] as const, 'role');
    if (!role) throw new AppError({ status: 422, code: 'validation/invalid', message: 'role is required', fields: { role: 'miner | trader' } });
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 5) || 5));
    const side = role === 'miner' ? 'sell' : 'buy';
    const orders = await Order.find({ side, status: 'completed' }).select('counterpartyId exceptions').limit(20_000).lean();
    const agg = new Map<string, { deals: number; held: number }>();
    for (const o of orders) {
      const a = agg.get(o.counterpartyId) ?? { deals: 0, held: 0 };
      a.deals += 1;
      if ((o.exceptions ?? []).some((e: { severity: string }) => e.severity === 'hold_order')) a.held += 1;
      agg.set(o.counterpartyId, a);
    }
    const ids = [...agg.keys()];
    const disputes = await Dispute.aggregate([{ $match: { partyId: { $in: ids } } }, { $group: { _id: '$partyId', n: { $sum: 1 } } }]);
    const disputeMap = new Map<string, number>(disputes.map((d) => [d._id as string, d.n as number]));
    const ranked = ids
      .map((id) => {
        const a = agg.get(id)!;
        const onTimePct = Number((((a.deals - a.held) / a.deals) * 100).toFixed(1));
        const rating = Math.min(5, Math.max(1, 5 - (3 * (disputeMap.get(id) ?? 0)) / a.deals - 1.5 * (1 - onTimePct / 100)));
        return { id, deals: a.deals, onTimePct, rating: Number(rating.toFixed(1)) };
      })
      .sort((x, y) => y.rating - x.rating || y.deals - x.deals)
      .slice(0, limit);
    const users = await loadUserMap(ranked.map((r) => r.id));
    res.json({ data: ranked.map((r) => ({ party: partyFrom(users, r.id), rating: r.rating, deals: r.deals, onTimePct: r.onTimePct })) });
  }),
];

