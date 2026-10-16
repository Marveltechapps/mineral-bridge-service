import { ActivityEvent } from '../../../models/platform.models.js';
import { LetterOfCredit, Negotiation, Passport } from '../../../models/finance.models.js';
import { Dispute, KycSubmission } from '../../../models/people.models.js';
import { Auction, IntakeItem, Offer, Order, Settlement, VaultLot } from '../../../models/trading.models.js';
import { KYC_OPEN_STATUSES, LC_STAGES, MS_DAY, MS_HOUR, ORDER_STAGES } from '../shared/enums.js';
import { badRequest } from '../../../common/errors/app-error.js';
import { iso } from '../shared/http.js';
import { addStored, convertQty, outMoneyOrZero, zeroStored, type QuantityUnit } from '../shared/money.js';
import { route, type AdminRouteDef } from '../shared/route-kit.js';
import { IN_CUSTODY } from '../vault/vault.service.js';
import { loadRateIndex, realisableOf } from '../pricing/rates.service.js';
import { parseWindow, pct, round1, startOfWeekUtc, usd, USD_MINOR } from './reporting.js';

const openKyc = { status: { $in: [...KYC_OPEN_STATUSES] } };

export const overviewRoutes: AdminRouteDef[] = [
  route(20, 'GET /overview/summary', ['orders', 'view'], async (_req, res) => {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * MS_DAY);
    const dayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    const [pendingKyc, pendingWeekAgo, overdue, stageRows, lots, idx, live, closingToday, weekSettle, offers, intake, unallocated, disputes] = await Promise.all([
      KycSubmission.countDocuments(openKyc),
      KycSubmission.countDocuments({ submittedAt: { $lt: weekAgo }, $or: [{ ...openKyc }, { decidedAt: { $gte: weekAgo } }] }),
      KycSubmission.countDocuments({ ...openKyc, $or: [{ slaDueAt: { $lt: now } }, { slaDueAt: { $exists: false }, submittedAt: { $lt: new Date(now.getTime() - 48 * MS_HOUR) } }] }),
      Order.aggregate([{ $match: { status: 'active' } }, { $group: { _id: '$stage', count: { $sum: 1 } } }]),
      VaultLot.find(IN_CUSTODY).lean(),
      loadRateIndex(),
      Auction.countDocuments({ status: 'live' }),
      Auction.countDocuments({ status: 'live', endsAt: { $gte: now, $lt: dayEnd } }),
      Settlement.aggregate([{ $match: { date: { $gte: startOfWeekUtc(now) }, status: { $in: ['released', 'pending'] } } }, { $group: { _id: '$status', n: { $sum: 1 }, minor: { $sum: USD_MINOR } } }]),
      Offer.countDocuments({ status: 'pending' }),
      IntakeItem.countDocuments({ status: 'pending' }),
      VaultLot.countDocuments({ status: 'in_vault', heldSince: { $lte: new Date(now.getTime() - 7 * MS_DAY) } }),
      Dispute.countDocuments({ status: { $ne: 'resolved' } }),
    ]);

    const byStage = new Map<string, number>(stageRows.map((r) => [r._id as string, r.count as number]));
    let cost = zeroStored();
    let real = zeroStored();
    const minerals = new Map<string, { mineral: string; real: ReturnType<typeof zeroStored>; kg: number; lots: number }>();
    for (const l of lots) {
      if (l.costBasis) cost = addStored(cost, l.costBasis);
      const { realisable } = realisableOf(l, idx);
      const r = realisable ?? zeroStored();
      real = addStored(real, r);
      const key = l.mineral?.name ?? 'Unknown';
      const m = minerals.get(key) ?? { mineral: key, real: zeroStored(), kg: 0, lots: 0 };
      m.real = addStored(m.real, r);
      m.kg += convertQty(l.quantity?.value ?? 0, (l.quantity?.unit ?? 'kg') as QuantityUnit, 'kg');
      m.lots += 1;
      minerals.set(key, m);
    }
    const settled = weekSettle.find((r) => r._id === 'released');
    const pending = weekSettle.find((r) => r._id === 'pending');

    res.json({
      kpis: {
        pendingKyc: { value: pendingKyc, deltaVsLastWeek: pendingKyc - pendingWeekAgo, overdue },
        activeOrders: { value: [...byStage.values()].reduce((a, b) => a + b, 0), byStage: ORDER_STAGES.map((stage) => ({ stage, count: byStage.get(stage) ?? 0 })) },
        vaultRealisable: { value: outMoneyOrZero(real), unrealisedPct: cost.amountMinor ? round1(((real.amountMinor - cost.amountMinor) / cost.amountMinor) * 100) : 0 },
        liveAuctions: { value: live, closingToday },
        settlementsThisWeek: { value: usd((settled?.minor ?? 0) + (pending?.minor ?? 0)), settled: settled?.n ?? 0, pending: pending?.n ?? 0 },
      },
      vaultByMineral: [...minerals.values()].sort((a, b) => b.real.amountMinor - a.real.amountMinor).map((m) => ({ mineral: m.mineral, realisable: outMoneyOrZero(m.real), quantity: { value: round1(m.kg), unit: 'kg' }, lots: m.lots })),
      deskQueues: [
        { key: 'kyc', label: 'KYC queue', sub: `${overdue} overdue past 48 h SLA`, count: pendingKyc, severity: overdue ? 'warn' : 'info', target: 'verification' },
        { key: 'offers', label: 'Offers to approve', count: offers, severity: offers > 10 ? 'warn' : 'info', target: 'pricing_offers' },
        { key: 'intake', label: 'Sell-intake requests', count: intake, severity: 'info', target: 'orders_intake' },
        { key: 'unallocated_lots', label: 'Unallocated lots (7+ days)', count: unallocated, severity: unallocated ? 'warn' : 'info', target: 'vault', filter: { status: 'in_vault', minDaysHeld: 7 } },
        { key: 'disputes', label: 'Open disputes', count: disputes, severity: disputes ? 'warn' : 'info', target: 'disputes' },
      ],
    });
  }),

  route(21, 'GET /overview/trade-finance', ['orders', 'view'], async (req, res) => {
    const w = parseWindow(req.query.window);
    const now = w.now;
    const weekAgo = new Date(now.getTime() - 7 * MS_DAY);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const usdLc = { 'amount.currency': 'USD' };
    const [neg, lcs, prevPaid, presentations, passports, passportsWeek, btc, allSettled] = await Promise.all([
      Negotiation.aggregate([{ $match: { status: { $ne: 'contracted' } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      LetterOfCredit.find({ createdAt: { $gte: w.from }, ...usdLc }).lean(),
      LetterOfCredit.find({ status: 'paid', createdAt: { $gte: w.prevFrom, $lt: w.from }, ...usdLc }).lean(),
      LetterOfCredit.find({ status: { $in: ['docs_presented', 'paid'] }, updatedAt: { $gte: monthStart } }).select('discrepancies').lean(),
      Passport.countDocuments({}),
      Passport.countDocuments({ mintedAt: { $gte: weekAgo } }),
      Settlement.aggregate([{ $match: { kind: 'btc_settlement', status: 'released', date: { $gte: w.from } } }, { $group: { _id: null, usd: { $sum: USD_MINOR }, btc: { $sum: { $cond: [{ $eq: ['$amount.currency', 'BTC'] }, '$amount.amountMinor', 0] } } } }]),
      Settlement.aggregate([{ $match: { status: 'released', date: { $gte: w.from } } }, { $group: { _id: null, usd: { $sum: USD_MINOR } } }]),
    ]);
    const negActive = neg.reduce((a, r) => a + (r.n as number), 0);
    const awaiting = neg.filter((r) => String(r._id).startsWith('awaiting')).reduce((a, r) => a + (r.n as number), 0);

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const stageIdx = (s: string) => (LC_STAGES as readonly string[]).indexOf(s);
    const sumMinor = (rows: Array<Record<string, any>>) => rows.reduce((a, r) => a + (r.amount?.amountMinor ?? 0), 0);
    const issued = lcs.filter((l) => stageIdx(l.status) >= 1);
    const paid = lcs.filter((l) => l.status === 'paid');
    const avgCycle = (rows: Array<Record<string, any>>) => (rows.length ? rows.reduce((a, l) => a + (new Date(l.updatedAt ?? 0).getTime() - new Date(l.createdAt ?? 0).getTime()) / MS_DAY, 0) / rows.length : 0);
    const cycle = avgCycle(paid);
    const withDisc = presentations.filter((l) => (l.discrepancies ?? []).length > 0).length;
    const btcUsd = btc[0]?.usd ?? 0;

    res.json({
      tiles: [
        { key: 'active_negotiations', value: negActive, sub: `${awaiting} awaiting a counter-offer`, target: 'collab' },
        { key: 'lc_issued_vs_paid', issued: usd(sumMinor(issued)), paid: usd(sumMinor(paid)), paidPct: pct(sumMinor(paid), sumMinor(issued)), target: 'lc' },
        { key: 'avg_lc_cycle_days', value: round1(cycle), deltaDays: prevPaid.length ? round1(cycle - avgCycle(prevPaid)) : 0, target: 'lc' },
        { key: 'discrepancy_rate', valuePct: presentations.length ? round1((withDisc / presentations.length) * 100) : 0, sub: `${withDisc} of ${presentations.length} presentations this month`, target: 'lc' },
        { key: 'passports_on_chain', value: passports, thisWeek: passportsWeek, target: 'chain' },
        { key: 'btc_settled_volume', value: usd(btcUsd), btc: Number(((btc[0]?.btc ?? 0) / 1e8).toFixed(4)), sharePct: pct(btcUsd, allSettled[0]?.usd ?? 0), target: 'chain' },
      ],
      lcFunnel: LC_STAGES.map((stage, i) => {
        const reached = lcs.filter((l) => stageIdx(l.status) >= i);
        return { stage, count: reached.length, value: usd(sumMinor(reached)) };
      }),
    });
  }),

  route(22, 'GET /overview/activity', ['orders', 'view'], async (req, res) => {
    const raw = Number(req.query.limit ?? 20);
    const limit = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), 50) : 20;
    let before: Date | undefined;
    if (req.query.before) {
      before = new Date(String(req.query.before));
      if (Number.isNaN(before.getTime())) throw badRequest('request/malformed', 'before must be an ISO timestamp');
    }
    const rows = await ActivityEvent.find(before ? { at: { $lt: before } } : {}).sort({ at: -1, _id: -1 }).limit(limit + 1).lean();
    const page = rows.slice(0, limit);
    res.json({
      data: page.map((a) => ({ id: a.activityId, text: a.text, meta: a.meta ?? '', at: iso(a.at), kind: a.kind, severity: a.severity, ref: a.ref?.id ? { type: a.ref.type, id: a.ref.id } : null })),
      meta: { nextBefore: rows.length > limit ? iso(page[page.length - 1]!.at) : null },
    });
  }),
];
