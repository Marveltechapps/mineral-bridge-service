import { Enrolment } from '../../../models/content.models.js';
import { User } from '../../../models/people.models.js';
import { Auction, Order } from '../../../models/trading.models.js';
import { MS_DAY, ORDER_STAGES } from '../shared/enums.js';
import { route, type AdminRouteDef } from '../shared/route-kit.js';
import { parseWindow, pct, round1, usd } from '../overview/reporting.js';

const TARGET_DAYS: Record<string, number> = { verification: 1.5, pricing_confirmation: 2, agent_visit: 2.9, inspection_approval: 2, payment_released: 1, custody_transfer: 3 };
const deltaPct = (cur: number, prev: number) => (prev ? round1(((cur - prev) / prev) * 100) : 0);

async function gmvMinor(from: Date, to: Date): Promise<number> {
  const rows = await Order.aggregate([{ $match: { status: { $in: ['active', 'completed'] }, openedAt: { $gte: from, $lt: to }, 'value.currency': 'USD' } }, { $group: { _id: null, minor: { $sum: '$value.amountMinor' } } }]);
  return rows[0]?.minor ?? 0;
}

async function avgCycleDays(from: Date, to: Date): Promise<number> {
  const rows = await Order.aggregate([{ $match: { status: 'completed', openedAt: { $gte: from, $lt: to } } }, { $group: { _id: null, avg: { $avg: { $subtract: ['$updatedAt', '$openedAt'] } } } }]);
  return rows[0]?.avg ? round1(rows[0].avg / MS_DAY) : 0;
}

async function fillRate(from: Date, to: Date): Promise<number> {
  const rows = await Auction.aggregate([{ $match: { status: 'ended', endsAt: { $gte: from, $lt: to } } }, { $group: { _id: null, total: { $sum: 1 }, met: { $sum: { $cond: [{ $eq: ['$outcome', 'reserve_met'] }, 1, 0] } } } }]);
  return pct(rows[0]?.met ?? 0, rows[0]?.total ?? 0);
}

export const analyticsRoutes: AdminRouteDef[] = [
  route(128, 'GET /analytics/summary', ['financial', 'view'], async (req, res) => {
    const w = parseWindow(req.query.window);
    const monthsBack = new Date(Date.UTC(w.now.getUTCFullYear() - 1, w.now.getUTCMonth() - 1, 1));
    const [gmv, gmvPrev, newUsers, accounts, cycle, cyclePrev, fill, fillPrev, byMineral, tiers, perMonth, learn, learnPrev, certs, orders] = await Promise.all([
      gmvMinor(w.from, w.now),
      gmvMinor(w.prevFrom, w.from),
      User.countDocuments({ createdAt: { $gte: w.from } }),
      User.countDocuments({ status: { $ne: 'suspended' } }),
      avgCycleDays(w.from, w.now),
      avgCycleDays(w.prevFrom, w.from),
      fillRate(w.from, w.now),
      fillRate(w.prevFrom, w.from),
      Order.aggregate([{ $match: { status: { $in: ['active', 'completed'] }, openedAt: { $gte: w.from }, 'value.currency': 'USD' } }, { $group: { _id: '$mineral.name', minor: { $sum: '$value.amountMinor' } } }, { $sort: { minor: -1 } }, { $limit: 12 }]),
      User.aggregate([{ $group: { _id: '$tier', users: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
      Auction.aggregate([{ $match: { status: 'ended', endsAt: { $gte: monthsBack } } }, { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$endsAt' } }, avg: { $avg: '$bidCount' } } }, { $sort: { _id: 1 } }]),
      Enrolment.aggregate([{ $match: { startedAt: { $gte: w.from } } }, { $group: { _id: null, started: { $sum: '$lessonsStarted' }, completed: { $sum: '$lessonsCompleted' } } }]),
      Enrolment.aggregate([{ $match: { startedAt: { $gte: w.prevFrom, $lt: w.from } } }, { $group: { _id: null, started: { $sum: '$lessonsStarted' }, completed: { $sum: '$lessonsCompleted' } } }]),
      Enrolment.countDocuments({ certificateId: { $gt: null }, completedAt: { $gte: w.from } }),
      Order.find({ openedAt: { $gte: w.from }, status: { $ne: 'draft' } }).select('stage stageEnteredAt stageLog status').limit(5000).lean(),
    ]);

    const totalUsers = tiers.reduce((a, t) => a + t.users, 0);
    const points = perMonth.filter((p) => p._id >= monthsBack.toISOString().slice(0, 7)).slice(-12).map((p) => ({ month: p._id as string, value: Math.round(p.avg) }));
    const last = perMonth[perMonth.length - 1];
    const yearAgoKey = last ? `${Number(String(last._id).slice(0, 4)) - 1}${String(last._id).slice(4)}` : '';
    const yearAgo = perMonth.find((p) => p._id === yearAgoKey);

    // Stage bottlenecks: mean days spent per stage across orders opened in the window.
    const spent = new Map<string, number[]>();
    for (const o of orders) {
      const log = [...(o.stageLog ?? [])].sort((a: { at: Date }, b: { at: Date }) => +new Date(a.at) - +new Date(b.at));
      log.forEach((entry: { stage: string; at: Date }, i: number) => {
        const next = log[i + 1]?.at ?? (entry.stage === o.stage && o.status === 'active' ? w.now : undefined);
        if (!next) return;
        spent.set(entry.stage, [...(spent.get(entry.stage) ?? []), (+new Date(next) - +new Date(entry.at)) / MS_DAY]);
      });
    }

    const lessonsStarted = learn[0]?.started ?? 0;
    const lessonsDone = learn[0]?.completed ?? 0;
    res.json({
      kpis: [
        { key: 'gmv', value: usd(gmv), deltaPct: deltaPct(gmv, gmvPrev) },
        { key: 'active_accounts', value: accounts, delta: newUsers },
        { key: 'avg_order_cycle_days', value: cycle, delta: cyclePrev ? round1(cycle - cyclePrev) : 0 },
        { key: 'auction_fill_rate', valuePct: fill, deltaPts: fill - fillPrev },
      ],
      gmvByMineral: byMineral.map((m) => ({ mineral: m._id ?? 'Unknown', value: usd(m.minor) })),
      tierDistribution: [1, 2, 3].map((tier) => {
        const users = tiers.find((t) => t._id === tier)?.users ?? 0;
        return { tier, users, pct: pct(users, totalUsers) };
      }),
      auctionPerformance: { metric: 'avg_bids_per_auction', points, yoyPct: last && yearAgo ? deltaPct(last.avg, yearAgo.avg) : 0 },
      academyEngagement: [
        { key: 'lessons_started', value: lessonsStarted, deltaPct: deltaPct(lessonsStarted, learnPrev[0]?.started ?? 0) },
        { key: 'lessons_completed', value: lessonsDone, deltaPct: deltaPct(lessonsDone, learnPrev[0]?.completed ?? 0) },
        { key: 'certificates_issued', value: certs, deltaPct: 0 },
      ],
      stageBottlenecks: ORDER_STAGES.map((stage) => {
        const xs = spent.get(stage) ?? [];
        const avg = xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
        const target = TARGET_DAYS[stage] ?? 2;
        return { stage, avgDays: avg, targetDays: target, status: avg <= target ? 'ok' : avg <= target * 1.25 ? 'warn' : 'bad' };
      }),
    });
  }),
];
