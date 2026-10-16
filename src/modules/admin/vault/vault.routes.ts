import { z } from 'zod';
import { AppError, conflict } from '../../../common/errors/app-error.js';
import { withTx } from '../../../common/db/transaction.js';
import { VaultLot } from '../../../models/trading.models.js';
import { auditActor } from '../shared/staff-context.js';
import { recordAudit } from '../../audit/audit.service.js';
import { loadRateIndex, realisableOf } from '../pricing/rates.service.js';
import { LOT_STATUSES } from '../shared/enums.js';
import { action, and, boolQ, daysBetween, intQ, oneOf, pageOf, paging, searchFilter, sortSpec } from '../shared/http.js';
import { addStored, outMoneyOrZero, zeroStored } from '../shared/money.js';
import { route, type AdminRouteDef } from '../shared/route-kit.js';
import { IN_CUSTODY, LOT_SORT, lotSummary, mapLotDetail, requireLot } from './vault.service.js';

export const vaultRoutes: AdminRouteDef[] = [
  route(34, 'GET /vault/summary', ['vault', 'view'], async (_req, res) => {
    const [lots, idx] = await Promise.all([VaultLot.find(IN_CUSTODY).lean(), loadRateIndex()]);
    const now = Date.now();
    let cost = zeroStored();
    let real = zeroStored();
    let totalDays = 0;
    let unallocated = 0;
    for (const l of lots) {
      if (l.costBasis) cost = addStored(cost, l.costBasis);
      const { realisable } = realisableOf(l, idx);
      if (realisable) real = addStored(real, realisable);
      const days = daysBetween(l.heldSince ?? l.createdAt, now);
      totalDays += days;
      if (l.status === 'in_vault' && days > 7) unallocated += 1;
    }
    const avg = lots.length ? Number((totalDays / lots.length).toFixed(1)) : 0;
    res.json({
      cards: [
        { key: 'lots_in_custody', label: 'Lots in custody', value: lots.length, sub: `${unallocated} unallocated >7 days` },
        { key: 'cost_basis', label: 'Cost basis', value: outMoneyOrZero(cost) },
        { key: 'realisable', label: 'Realisable value', value: outMoneyOrZero(real), ...(cost.amountMinor ? { trend: { direction: real.amountMinor >= cost.amountMinor ? 'up' : 'down', text: `${(((real.amountMinor - cost.amountMinor) / cost.amountMinor) * 100).toFixed(1)}% vs cost`, tone: real.amountMinor >= cost.amountMinor ? 'ok' : 'warn' } } : {}) },
        { key: 'avg_days_held', label: 'Average days held', value: avg, unit: 'days', sub: 'Target 45 days' },
      ],
    });
  }),

  route(35, 'GET /vault/lots', ['vault', 'view'], async (req, res) => {
    const status = oneOf(req.query.status, LOT_STATUSES, 'status');
    const allocatable = boolQ(req.query.allocatable);
    const minDaysHeld = intQ(req.query.minDaysHeld, 'minDaysHeld');
    const mineral = typeof req.query.mineral === 'string' && req.query.mineral ? req.query.mineral : undefined;
    const filter = and(
      status && { status },
      allocatable && { status: 'in_vault' },
      minDaysHeld !== undefined && { heldSince: { $lte: new Date(Date.now() - minDaysHeld * 86_400_000) } },
      mineral && { $or: [{ 'mineral.name': mineral }, { 'mineral.id': mineral }] },
      searchFilter(req.query.q, ['lotId', 'mineral.name', 'grade', 'sourceOrderId', 'status']),
    );
    const sort = sortSpec(req, LOT_SORT, { heldSince: 1, _id: 1 });
    if ('heldSince' in sort) sort.heldSince = (sort.heldSince === 1 ? -1 : 1) as 1 | -1; // more days held first on asc
    res.json(await pageOf(VaultLot, { filter, sort, paging: paging(req), map: (docs: unknown[]) => docs.map(lotSummary), totalUnfiltered: IN_CUSTODY }));
  }),

  route(36, 'GET /vault/lots/:lotId', ['vault', 'view'], async (req, res) => {
    res.json(await mapLotDetail(await requireLot(String(req.params.lotId))));
  }),

  route(37, 'POST /vault/lots/:lotId/hold', ['vault', 'edit'], async (req, res) => {
    const lotId = String(req.params.lotId);
    const body = req.body as { reason: string; reviewOn: string; visibleInUnallocatedQueue: boolean };
    const lot = await requireLot(lotId);
    if (lot.status === 'shipped') throw new AppError({ status: 422, code: 'rule/lot-shipped', message: `${lotId} has shipped and cannot be held.` });
    if (lot.status === 'listed' || lot.status === 'in_auction') {
      throw conflict('conflict/stale-state', `${lotId} is ${lot.status === 'listed' ? 'listed in the catalog' : 'in an auction'} — end that first.`, { details: { status: lot.status } });
    }
    const actor = auditActor(req);
    const now = new Date();
    const { updated, auditId } = await withTx(async (session) => {
      const updated = await VaultLot.findOneAndUpdate(
        { lotId, status: { $in: ['in_vault', 'reserved'] } },
        {
          $set: { status: 'reserved', hold: { ...body, heldBy: actor.staffId, at: now } },
          $push: { allocationHistory: { title: 'Held in vault reserve', sub: body.reason, date: now } },
        },
        { new: true, session },
      ).lean();
      if (!updated) throw conflict('conflict/stale-state', `${lotId} changed state — refresh and try again.`);
      const auditId = await recordAudit({
        actor,
        category: 'vault',
        action: 'Held lot in vault reserve',
        record: { type: 'lot', id: lotId, label: lotId },
        before: { status: lot.status, hold: lot.hold?.reason ?? null },
        after: { status: 'reserved', reason: body.reason, reviewOn: body.reviewOn, visibleInUnallocatedQueue: body.visibleInUnallocatedQueue },
        reason: body.reason,
        req,
        session,
        activity: { text: `Lot ${lotId} held in vault reserve`, meta: body.reason, kind: 'vault' },
      });
      return { updated, auditId };
    });
    res.json(action(await mapLotDetail(updated), `Lot ${lotId} held in vault reserve`, auditId));
  }, {
    body: z.object({
      reason: z.string().trim().min(3, 'Give a reason').max(500),
      reviewOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
      visibleInUnallocatedQueue: z.boolean().default(false),
    }),
  }),
];

