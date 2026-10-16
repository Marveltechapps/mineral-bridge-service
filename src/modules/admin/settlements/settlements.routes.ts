import { AppError, badRequest } from '../../../common/errors/app-error.js';
import { Settlement } from '../../../models/trading.models.js';
import { recordAudit } from '../../audit/audit.service.js';
import { SETTLEMENT_KINDS, SETTLEMENT_STATUSES } from '../shared/enums.js';
import { and, escapeRegex, iso, oneOf, pageOf, paging, sendCsv, sortSpec, toCsv } from '../shared/http.js';
import { outMoney } from '../shared/money.js';
import { loadUserMap, partyFrom } from '../shared/refs.js';
import { route, type AdminRouteDef } from '../shared/route-kit.js';
import { auditActor } from '../shared/staff-context.js';
import { userIdsMatching } from '../people/people.dto.js';
import { startOfWeekUtc, usd, USD_MINOR } from '../overview/reporting.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function periodRange(period: unknown, required: boolean): { from: Date; to: Date; label: string; key: string } | null {
  if (period === undefined || period === '') {
    if (required) throw badRequest('request/malformed', 'period is required (YYYY-MM)', { period: 'Required' });
    return null;
  }
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(period));
  if (!m) throw badRequest('request/malformed', 'period must be YYYY-MM', { period: 'Use YYYY-MM' });
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  return { from: new Date(Date.UTC(year, month, 1)), to: new Date(Date.UTC(year, month + 1, 1)), label: `${MONTHS[month]} ${year}`, key: String(period) };
}

function settlementDto(s: Record<string, any>, parties: Map<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    id: s.settlementId,
    date: iso(s.date),
    ref: s.ref?.id ? { type: s.ref.type, id: s.ref.id } : null,
    party: partyFrom(parties, s.partyId),
    kind: s.kind,
    amount: outMoney(s.amount),
    status: s.status,
    ...(s.rail ? { rail: s.rail } : {}),
  };
}

async function ledgerFilter(req: import('express').Request, requirePeriod = false) {
  const status = oneOf(req.query.status, SETTLEMENT_STATUSES, 'status');
  const kind = oneOf(req.query.kind, SETTLEMENT_KINDS, 'kind');
  const range = periodRange(req.query.period, requirePeriod);
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  let search: Record<string, unknown> | null = null;
  if (q) {
    const re = new RegExp(escapeRegex(q), 'i');
    const uids = await userIdsMatching(q);
    search = { $or: [{ settlementId: re }, { 'ref.id': re }, { kind: re }, { status: re }, { partyId: { $in: uids } }] };
  }
  return { filter: and(status && { status }, kind && { kind }, range && { date: { $gte: range.from, $lt: range.to } }, search), range };
}

export const settlementRoutes: AdminRouteDef[] = [
  route(125, 'GET /settlements/summary', ['financial', 'view'], async (req, res) => {
    const range = periodRange(req.query.period, false) ?? periodRange(new Date().toISOString().slice(0, 7), true)!;
    const feeUsd = { $cond: [{ $eq: ['$feeAmount.currency', 'USD'] }, '$feeAmount.amountMinor', 0] };
    const [held, week, hold, period] = await Promise.all([
      Settlement.aggregate([{ $match: { status: { $in: ['pending', 'on_hold', 'disputed'] } } }, { $group: { _id: null, n: { $sum: 1 }, minor: { $sum: USD_MINOR } } }]),
      Settlement.aggregate([{ $match: { status: 'released', date: { $gte: startOfWeekUtc() } } }, { $group: { _id: null, n: { $sum: 1 }, minor: { $sum: USD_MINOR } } }]),
      Settlement.aggregate([{ $match: { status: { $in: ['on_hold', 'disputed'] } } }, { $group: { _id: '$status', n: { $sum: 1 }, minor: { $sum: USD_MINOR } } }]),
      Settlement.aggregate([{ $match: { status: 'released', date: { $gte: range.from, $lt: range.to } } }, { $group: { _id: null, fee: { $sum: feeUsd }, volume: { $sum: USD_MINOR } } }]),
    ]);
    const onHold = hold.reduce((a, r) => a + r.minor, 0);
    const disputed = hold.find((r) => r._id === 'disputed')?.n ?? 0;
    const fee = period[0]?.fee ?? 0;
    const volume = period[0]?.volume ?? 0;
    res.json({
      cards: [
        { key: 'held_in_escrow', label: 'Held in escrow', value: usd(held[0]?.minor ?? 0), sub: `${held[0]?.n ?? 0} open settlements` },
        { key: 'released_this_week', label: 'Released this week', value: usd(week[0]?.minor ?? 0), sub: `${week[0]?.n ?? 0} released` },
        { key: 'on_hold', label: 'On hold', value: usd(onHold), sub: `${disputed} under dispute` },
        { key: 'fee_revenue', label: `Fee revenue · ${range.label}`, value: usd(fee), sub: `${volume ? ((fee / volume) * 100).toFixed(2) : '0.00'}% blended take`, unit: undefined },
      ],
      period: range.key,
    });
  }),

  route(126, 'GET /settlements', ['financial', 'view'], async (req, res) => {
    const { filter } = await ledgerFilter(req);
    res.json(
      await pageOf(Settlement, {
        filter,
        sort: sortSpec(req, { id: 'settlementId', date: 'date', amount: 'amount.amountMinor', status: 'status' }, { date: -1, _id: 1 }),
        paging: paging(req),
        map: async (docs: any[]) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          const parties = await loadUserMap(docs.map((d) => d.partyId));
          return docs.map((d) => settlementDto(d, parties));
        },
      }),
    );
  }),

  route(127, 'GET /settlements/statement', ['financial', 'view'], async (req, res) => {
    const format = oneOf(req.query.format, ['csv', 'pdf'] as const, 'format') ?? 'csv';
    const { filter, range } = await ledgerFilter(req, true);
    if (format === 'pdf') {
      throw new AppError({ status: 501, code: 'export/format-unsupported', message: 'PDF statements are not available yet — use format=csv.' });
    }
    const rows = await Settlement.find(filter).sort({ date: 1, _id: 1 }).limit(100_000).lean();
    const parties = await loadUserMap(rows.map((r) => r.partyId));
    await recordAudit({ actor: auditActor(req), category: 'financial', action: 'Exported settlement statement', record: { type: 'settlement', id: range!.key, label: `${range!.label} statement` }, after: { rows: rows.length, format }, req });
    res.setHeader('X-Export-Message', `${range!.label} statement exported as CSV`);
    sendCsv(res, `settlements-${range!.key}.csv`, toCsv(['settlement_id', 'date', 'kind', 'reference_type', 'reference_id', 'party', 'amount', 'currency', 'fee', 'status', 'rail'], rows.map((s) => {
      const d = settlementDto(s, parties);
      return [d.id, d.date, d.kind, d.ref?.type ?? '', d.ref?.id ?? '', d.party?.name ?? '', d.amount?.amount ?? '', d.amount?.currency ?? '', s.feeAmount ? (s.feeAmount.amountMinor / 10 ** (s.feeAmount.scale ?? 2)).toFixed(s.feeAmount.scale ?? 2) : '', d.status, d.rail ?? ''];
    })));
  }),
];
