import { z } from 'zod';
import { AppError, conflict, notFound, unprocessable } from '../../../common/errors/app-error.js';
import { withTx } from '../../../common/db/transaction.js';
import { nextId } from '../../../common/db/sequence.js';
import { docEtag, setEtag } from '../../../common/http/etag.js';
import { User } from '../../../models/people.models.js';
import { Listing, IntakeItem, Offer, Order, Rate, Settlement, VaultLot } from '../../../models/trading.models.js';
import { Role } from '../../auth/auth.models.js';
import { StaffModel } from '../../staff/staff.model.js';
import { assertFourEyes, auditActor, staffActor } from '../shared/staff-context.js';
import { recordAudit } from '../../audit/audit.service.js';
import { Mineral } from '../../reference/reference.model.js';
import { mintPassport, recordChainEvent } from '../chain/chain.service.js';
import { ORDER_EXPORT_SYNC_LIMIT, queueExport } from '../exports/exports.service.js';
import { createSettlement } from '../settlements/settlements.service.js';
import { getPlatformValues } from '../settings/settings.service.js';
import { ORDER_STAGES, ORDER_STAGE_LABEL, EXCEPTION_TYPES, MS_HOUR, type OrderStage } from '../shared/enums.js';
import { action, pageOf, paging, sendCsv, sortSpec, toCsv, isoDate, searchFilter } from '../shared/http.js';
import { sendCustomerMessage } from '../shared/messaging.js';
import {
  adminMoneySchema,
  adminQuantitySchema,
  convertQty,
  formatMoneyText,
  outMoney,
  outQty,
  outUnitPrice,
  parsePositiveMoney,
  priceTimesQuantity,
  type StoredUnitPrice,
} from '../shared/money.js';
import { notifyStaff } from '../shared/notify.js';
import { loadFileRefs } from '../shared/files.js';
import { loadStaffMap, loadUserMap, partyFrom, requireUser } from '../shared/refs.js';
import { route, type AdminRouteDef } from '../shared/route-kit.js';
import { ORDER_SORT, buildOrderFilter, mapOrderDetail, mapOrderSummaries, requireOrder, stageIndex } from './orders.service.js';

function staleStage(o: Record<string, any>, expected?: string) // eslint-disable-line @typescript-eslint/no-explicit-any
 {
  return conflict('conflict/stale-state', `${o.orderId} is already at ${ORDER_STAGE_LABEL[o.stage as OrderStage] ?? o.stage}.`, {
    details: { currentStage: o.stage, ...(expected ? { expectedStage: expected } : {}) },
  });
}

async function defaultRoute(side: 'buy' | 'sell', user: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const place = user.country ?? 'KE';
  return side === 'sell'
    ? {
        direction: 'seller_to_vault',
        summary: `${user.org || user.name} → Mineral Bridge vault`,
        stops: [
          { kind: 'seller_site', name: user.org || user.name, place, note: 'Sealed sample taken' },
          { kind: 'inspection_hub', name: 'Inspection hub', place: 'Nairobi', note: 'Assay and weighing' },
          { kind: 'bonded_carrier', name: 'Bonded carrier', place: 'In transit', note: 'Escorted transfer' },
          { kind: 'mb_vault', name: 'Mineral Bridge vault', place: 'Nairobi', note: 'Custody transfer' },
        ],
      }
    : {
        direction: 'vault_to_buyer',
        summary: `Mineral Bridge vault → ${user.org || user.name}`,
        stops: [
          { kind: 'mb_vault', name: 'Mineral Bridge vault', place: 'Nairobi', note: 'Release from custody' },
          { kind: 'bonded_carrier', name: 'Bonded carrier', place: 'In transit', note: 'Escorted transfer' },
          { kind: 'buyer_site', name: user.org || user.name, place, note: 'Delivery' },
        ],
      };
}

const createOrderBody = z.object({
  side: z.enum(['buy', 'sell']),
  counterpartyId: z.string().min(1),
  mineralId: z.string().optional(),
  declaredQuantity: adminQuantitySchema.optional(),
  listingId: z.string().optional(),
  quantity: adminQuantitySchema.optional(),
  agentId: z.string().optional(),
  note: z.string().max(1000).optional(),
  draft: z.boolean().default(false),
});

export const orderRoutes: AdminRouteDef[] = [
  route(23, 'GET /orders', ['orders', 'view'], async (req, res) => {
    const { filter, noStage } = await buildOrderFilter(req.query);
    const sort = sortSpec(req, ORDER_SORT, { openedAt: -1, _id: 1 });
    // "days in stage" desc ⇒ oldest stageEnteredAt first
    if ('stageEnteredAt' in sort) sort.stageEnteredAt = (sort.stageEnteredAt === 1 ? -1 : 1) as 1 | -1;
    res.json(
      await pageOf(Order, {
        filter,
        sort,
        paging: paging(req),
        map: mapOrderSummaries,
        counts: async () => {
          const rows = await Order.aggregate([{ $match: noStage }, { $group: { _id: '$stage', n: { $sum: 1 } } }]);
          const counts: Record<string, number> = { all: 0 };
          for (const s of ORDER_STAGES) counts[s] = 0;
          for (const r of rows) {
            counts[r._id] = r.n;
            counts.all! += r.n;
          }
          return counts;
        },
      }),
    );
  }),

  route(24, 'GET /orders/export', ['orders', 'view'], async (req, res) => {
    const a = staffActor(req);
    const { filter } = await buildOrderFilter(req.query);
    const total = await Order.countDocuments(filter);
    await recordAudit({ actor: auditActor(req), category: 'orders', action: 'Exported orders', record: { type: 'order', id: 'export', label: 'Orders export' }, after: { rows: total, filter: req.query }, req });
    if (total > ORDER_EXPORT_SYNC_LIMIT) {
      const exportId = await queueExport({ kind: 'orders', format: 'csv', filters: req.query as Record<string, unknown>, requestedBy: a.staffId });
      res.status(202).json({ exportId, message: 'Export queued — you will get an email' });
      return;
    }
    const sort = sortSpec(req, ORDER_SORT, { openedAt: -1, _id: 1 });
    const docs = await Order.find(filter).sort(sort).lean();
    const [users, staff] = await Promise.all([loadUserMap(docs.map((d) => d.counterpartyId)), loadStaffMap(docs.map((d) => d.agentId))]);
    const csv = toCsv(
      ['id', 'side', 'mineral', 'party', 'quantity', 'unit', 'stage', 'days_in_stage', 'agent', 'opened_at'],
      (await mapOrderSummaries(docs)).map((o, i) => [o.id, o.side, o.mineral, users.get(docs[i]!.counterpartyId)?.name, o.quantity?.value, o.quantity?.unit, ORDER_STAGE_LABEL[o.stage as OrderStage], o.daysInStage, staff.get(docs[i]!.agentId)?.name, o.openedAt]),
    );
    sendCsv(res, `orders-${isoDate()}.csv`, csv);
  }),

  route(25, 'POST /orders', ['orders', 'edit'], async (req, res) => {
    const body = req.body as z.infer<typeof createOrderBody>;
    const actor = auditActor(req);
    const user = await requireUser(body.counterpartyId);
    const platform = await getPlatformValues();

    let mineral: { id?: string; name: string };
    let grade: string | undefined;
    let quantity = body.side === 'sell' ? body.declaredQuantity : body.quantity;
    let listing: Record<string, any> | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any

    if (body.side === 'buy') {
      if (!body.listingId || !body.quantity) {
        throw new AppError({ status: 422, code: 'rule/buy-requires-listing', message: 'Buy orders need a catalog listing and a quantity.', fields: { listingId: 'Required for buy orders' } });
      }
      listing = await Listing.findOne({ listingId: body.listingId }).lean();
      if (!listing) throw notFound('resource/not-found', `Listing ${body.listingId} not found`);
      mineral = { id: listing.mineral?.id, name: listing.mineral?.name };
      grade = listing.grade;
    } else {
      if (!body.mineralId) throw unprocessable('Select a mineral', { mineralId: 'Required' });
      if (!body.declaredQuantity) throw unprocessable('Enter the declared quantity', { declaredQuantity: 'Required' });
      const m = await Mineral.findOne({ mineralId: body.mineralId }).lean();
      if (!m) throw unprocessable('Unknown mineral', { mineralId: 'Unknown mineral' });
      mineral = { id: m.mineralId, name: m.name };
    }

    let agentId = body.agentId;
    if (agentId) {
      const agent = await StaffModel.findOne({ publicId: agentId, disabled: false }).lean();
      if (!agent) throw new AppError({ status: 422, code: 'rule/agent-unavailable', message: 'That agent is not available.', fields: { agentId: 'Agent unavailable' } });
    } else {
      agentId = actor.staffId;
    }

    if (!body.draft) {
      if (user.status !== 'verified') throw new AppError({ status: 422, code: 'rule/counterparty-not-verified', message: `${user.name} is not verified yet.`, fields: { counterpartyId: 'Counterparty must be verified' } });
      const kg = convertQty(quantity!.value, quantity!.unit, 'kg');
      const cap = user.tier === 1 ? platform.tier1_order_cap_kg : user.tier === 2 ? platform.tier2_order_cap_kg : Infinity;
      if (kg > cap!) {
        throw new AppError({ status: 422, code: 'rule/tier-quantity-limit', message: `Tier ${user.tier} accounts are capped at ${cap} kg per order.`, details: { tier: user.tier, capKg: cap } });
      }
    }

    // Price: buy = listing ask, sell = current desk buy rate for that mineral.
    let lockedRate: StoredUnitPrice | undefined;
    if (listing) {
      lockedRate = listing.askPrice as StoredUnitPrice;
    } else {
      const rate = await Rate.findOne({ mineral: mineral.name, ...(grade ? { grade } : {}) }).lean();
      lockedRate = (rate?.buy as StoredUnitPrice | undefined) ?? undefined;
    }
    const value = lockedRate ? priceTimesQuantity(lockedRate, quantity!) : undefined;

    const orderId = await nextId(body.side === 'sell' ? 'orderSell' : 'orderBuy');
    const now = new Date();
    const route_ = await defaultRoute(body.side, user);

    const { order, auditId } = await withTx(async (session) => {
      if (listing && !body.draft) {
        const need = convertQty(body.quantity!.value, body.quantity!.unit, listing.quantityLeft.unit);
        const upd = await Listing.findOneAndUpdate(
          { listingId: listing.listingId, status: 'live', 'quantityLeft.value': { $gte: need } },
          { $inc: { 'quantityLeft.value': -need } },
          { new: true, session },
        ).lean();
        if (!upd) throw conflict('conflict/stale-state', `${listing.listingId} no longer has that quantity available.`);
        if (upd.quantityLeft.value <= 1e-9) await Listing.updateOne({ listingId: listing.listingId }, { $set: { status: 'sold_out' } }, { session });
      }
      const [created] = await Order.create(
        [
          {
            orderId,
            side: body.side,
            status: body.draft ? 'draft' : 'active',
            mineral,
            grade,
            counterpartyId: user.userId,
            quantity,
            stage: 'verification',
            stageEnteredAt: now,
            openedAt: now,
            agentId,
            value,
            lockedRate,
            escrowRef: body.side === 'buy' ? `ESC-${orderId}` : undefined,
            origin: body.side === 'sell' ? user.org || user.name : 'Mineral Bridge vault',
            destination: body.side === 'sell' ? 'Mineral Bridge vault' : user.org || user.name,
            note: body.note,
            route: route_,
            stageLog: body.draft ? [] : [{ stage: 'verification', at: now, agentId, description: 'Order opened' }],
            history: [{ text: body.draft ? 'Order saved as a draft' : 'Order created at Verification', actorId: actor.staffId, at: now }],
            listingId: listing?.listingId,
            lotId: listing?.lotId,
            createdBy: actor.staffId,
          },
        ],
        { session },
      );
      const auditId = await recordAudit({
        actor,
        category: 'orders',
        action: body.draft ? 'Saved order draft' : 'Created order',
        record: { type: 'order', id: orderId, label: orderId },
        after: { side: body.side, counterparty: user.name, mineral: mineral.name, quantity, stage: 'verification' },
        req,
        session,
        activity: body.draft ? undefined : { text: `Order ${orderId} created at Verification`, meta: `${user.org || user.name} · ${quantity!.value} ${quantity!.unit} ${mineral.name}`, kind: 'order' },
      });
      return { order: created.toObject(), auditId };
    });
    res.status(201).json(action(await mapOrderDetail(order), body.draft ? 'Order saved as a draft' : 'Order created at Verification', auditId));
  }, { body: createOrderBody }),

  route(26, 'GET /orders/:orderId', ['orders', 'view'], async (req, res) => {
    const o = await requireOrder(String(req.params.orderId));
    setEtag(res, docEtag(o));
    res.json(await mapOrderDetail(o));
  }),

  route(27, 'POST /orders/:orderId/advance', ['orders', 'edit'], async (req, res) => {
    const orderId = String(req.params.orderId);
    const { expectedStage, note } = req.body as { expectedStage: OrderStage; note?: string };
    const o = await requireOrder(orderId);
    if (o.status === 'draft') throw new AppError({ status: 422, code: 'rule/order-draft', message: `${orderId} is still a draft.` });
    if (o.stage !== expectedStage) throw staleStage(o, expectedStage);
    if (o.stage === 'custody_transfer') {
      throw new AppError({ status: 422, code: 'rule/order-complete', message: `Order ${orderId} has completed custody transfer.` });
    }
    if ((o.exceptions ?? []).some((e: { severity: string; status: string }) => e.severity === 'hold_order' && e.status === 'open')) {
      throw new AppError({ status: 422, code: 'rule/order-on-hold', message: `${orderId} has an open exception holding the order.` });
    }
    const next = ORDER_STAGES[stageIndex(o.stage) + 1]!;
    const actor = auditActor(req);

    let offer: Record<string, any> | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (next === 'payment_released' && o.side === 'sell') {
      offer = await Offer.findOne({ orderId, status: { $in: ['approved', 'adjusted', 'sent'] } }).sort({ createdAt: -1 }).lean();
      if (!offer) throw new AppError({ status: 422, code: 'rule/offer-not-approved', message: 'A firm offer must be approved before payment can be released.' });
    }
    if (next === 'custody_transfer') {
      const paid = await Settlement.findOne({ 'ref.id': orderId, status: 'released', kind: { $in: ['seller_payout', 'buy_settlement'] } }).lean();
      if (!paid) throw new AppError({ status: 422, code: 'rule/payment-not-recorded', message: 'Payment settlement must be recorded before custody transfer.' });
    }
    if (next === 'custody_transfer' && o.side === 'sell') {
      offer = await Offer.findOne({ orderId, status: { $in: ['approved', 'adjusted', 'sent'] } }).sort({ createdAt: -1 }).lean();
    }

    const label = ORDER_STAGE_LABEL[next];
    const now = new Date();
    const lotId = next === 'custody_transfer' && o.side === 'sell' ? await nextId('lot') : undefined;

    const { updated, auditId } = await withTx(async (session) => {
      const set: Record<string, unknown> = { stage: next, stageEnteredAt: now, stagePausedMs: 0 };
      if (o.stage === 'inspection_approval') set.assayStatus = 'approved';
      if (next === 'payment_released') {
        const amount = (offer?.amount as typeof o.value | undefined) ?? o.value;
        if (amount) {
          await createSettlement({
            kind: o.side === 'sell' ? 'seller_payout' : 'buy_settlement',
            ref: { type: 'order', id: orderId },
            partyId: o.counterpartyId,
            amount,
            status: 'released',
            rail: 'bank',
            escrowRef: o.escrowRef,
            createdBy: actor.staffId,
            session,
          });
          set.releasedAmount = amount;
        }
        set.paymentStatus = 'released';
      }
      if (lotId) set.lotId = lotId;
      const updated = await Order.findOneAndUpdate(
        { orderId, stage: expectedStage, status: 'active' },
        {
          $set: set,
          $push: {
            stageLog: { stage: next, at: now, agentId: o.agentId, description: note ?? STAGE_NOTE(label) },
            history: { text: `Advanced to ${label}${note ? ` — ${note}` : ''}`, actorId: actor.staffId, at: now },
          },
        },
        { new: true, session },
      ).lean();
      if (!updated) throw staleStage(o, expectedStage);

      if (lotId) {
        const qty = (offer?.assayed as typeof o.quantity | undefined) ?? o.quantity;
        const [lot] = await VaultLot.create(
          [
            {
              lotId,
              mineral: o.mineral,
              grade: offer?.assay?.grade ?? o.grade,
              quantity: qty,
              sourceOrderId: orderId,
              status: 'in_vault',
              location: 'Vault A — unassigned bay',
              costBasis: updated.releasedAmount ?? o.value,
              costRate: o.lockedRate,
              heldSince: now,
              custody: (updated.stageLog ?? []).map((l: { stage: string; at: Date; description: string }) => ({ title: ORDER_STAGE_LABEL[l.stage as OrderStage], description: l.description, at: l.at, actor: actor.name, state: 'done' })),
              assay: { certificateNo: offer?.assay?.certificateNo, fileId: offer?.assay?.fileId, labId: o.labId, grade: offer?.assay?.grade ?? o.grade, netQuantity: qty },
              allocationHistory: [{ title: 'Received into vault', sub: `From ${orderId}`, date: now }],
            },
          ],
          { session },
        );
        const passport = await mintPassport({ lotId, orderId, mineral: o.mineral?.name, grade: lot.grade, quantity: qty as { value: number; unit: string }, session });
        await VaultLot.updateOne({ lotId }, { $set: { passportId: passport.passportId } }, { session });
        await recordChainEvent({ type: 'custody_transfer', ref: { type: 'lot', id: lotId, label: lotId }, description: `Custody of ${lotId} transferred to Mineral Bridge vault`, payload: { orderId }, session });
      } else if (next === 'custody_transfer') {
        await recordChainEvent({ type: 'custody_transfer', ref: { type: 'order', id: orderId, label: orderId }, description: `${orderId} delivered to buyer`, payload: { orderId }, session });
      }
      const auditId = await recordAudit({
        actor,
        category: 'orders',
        action: `Advanced order to ${label}`,
        record: { type: 'order', id: orderId, label: orderId },
        before: { stage: o.stage },
        after: { stage: next, ...(note ? { note } : {}) },
        req,
        session,
        activity: { text: `Order ${orderId} moved to ${label}`, meta: `${o.mineral?.name} · ${outQty(o.quantity)?.value} ${o.quantity?.unit}`, kind: 'order' },
      });
      return { updated, auditId };
    });
    res.json(action(await mapOrderDetail(updated), `${orderId} advanced to ${label}`, auditId));
  }, { body: z.object({ expectedStage: z.enum(ORDER_STAGES), note: z.string().max(1000).optional() }) }),

  route(28, 'POST /orders/:orderId/exceptions', ['orders', 'edit'], async (req, res) => {
    const orderId = String(req.params.orderId);
    const body = req.body as { type: (typeof EXCEPTION_TYPES)[number]; severity: 'note' | 'hold_order'; description: string; draft: boolean };
    const o = await requireOrder(orderId);
    const actor = auditActor(req);
    const excId = await nextId('exception');
    const now = new Date();
    const exc = {
      id: excId,
      type: body.type,
      severity: body.severity,
      description: body.description,
      openedAt: now,
      openedBy: actor.staffId,
      status: body.draft ? 'draft' : 'open',
      ...(body.severity === 'hold_order' && !body.draft ? { holdStartedAt: now } : {}),
    };
    const auditId = await withTx(async (session) => {
      await Order.updateOne({ orderId }, { $push: { exceptions: exc, history: { text: `Exception flagged: ${body.type.replace(/_/g, ' ')}${body.draft ? ' (draft)' : ''}`, actorId: actor.staffId, at: now } } }, { session });
      const id = await recordAudit({
        actor,
        category: 'orders',
        action: body.draft ? 'Saved exception draft' : 'Flagged order exception',
        record: { type: 'order', id: orderId, label: orderId },
        before: { openExceptions: (o.exceptions ?? []).filter((e: { status: string }) => e.status === 'open').length },
        after: { exceptionId: excId, type: body.type, severity: body.severity },
        reason: body.description,
        req,
        session,
        activity: body.draft ? undefined : { text: `Exception flagged on ${orderId}: ${body.type.replace(/_/g, ' ')}`, meta: o.mineral?.name, kind: 'order', severity: 'warn' },
      });
      if (!body.draft) {
        await notifyStaff({ module: 'compliance', text: `${orderId} flagged — ${body.type.replace(/_/g, ' ')}`, severity: body.severity === 'hold_order' ? 'high' : 'medium', target: { type: 'order', id: orderId }, session });
      }
      return id;
    });
    res.status(201).json(action({ id: excId, status: exc.status }, body.draft ? 'Exception saved as a draft' : `Exception flagged on ${orderId} — compliance notified`, auditId));
  }, {
    body: z.object({
      type: z.enum(EXCEPTION_TYPES),
      severity: z.enum(['note', 'hold_order']),
      description: z.string().trim().min(3, 'Describe the exception').max(2000),
      draft: z.boolean().default(false),
    }),
  }),

  route(29, 'PUT /orders/:orderId/assignee', ['orders', 'edit'], async (req, res) => {
    const orderId = String(req.params.orderId);
    const { agentId, reason, handoverNote } = req.body as { agentId: string; reason?: string; handoverNote?: string };
    const o = await requireOrder(orderId);
    const agent = await StaffModel.findOne({ publicId: agentId, disabled: false }).lean();
    const role = agent ? await Role.findOne({ roleId: agent.role?.id }).lean() : null;
    if (!agent || role?.kind === 'content') {
      throw new AppError({ status: 422, code: 'rule/agent-unavailable', message: 'That agent is not available.', fields: { agentId: 'Agent unavailable' } });
    }
    const actor = auditActor(req);
    const now = new Date();
    const { updated, auditId } = await withTx(async (session) => {
      const updated = await Order.findOneAndUpdate(
        { orderId },
        { $set: { agentId }, $push: { history: { text: `Reassigned to ${agent.name}${handoverNote ? ` — ${handoverNote}` : ''}`, actorId: actor.staffId, at: now } } },
        { new: true, session },
      ).lean();
      const auditId = await recordAudit({
        actor,
        category: 'orders',
        action: 'Changed order assignee',
        record: { type: 'order', id: orderId, label: orderId },
        before: { agentId: o.agentId },
        after: { agentId, handoverNote },
        reason,
        req,
        session,
      });
      return { updated, auditId };
    });
    res.json(action(await mapOrderDetail(updated), `${orderId} reassigned to ${agent.name}`, auditId));
  }, { body: z.object({ agentId: z.string().min(1), reason: z.string().max(200).optional(), handoverNote: z.string().max(1000).optional() }) }),

  route(30, 'POST /orders/:orderId/messages', ['orders', 'edit'], async (req, res) => {
    const orderId = String(req.params.orderId);
    const body = req.body as { subject?: string; body: string; channels: Array<'sms' | 'in_app'>; draft: boolean };
    const o = await requireOrder(orderId);
    const actor = auditActor(req);
    const sent = await sendCustomerMessage({ userId: o.counterpartyId, subject: body.subject, body: body.body, channels: body.channels, draft: body.draft, related: { type: 'order', id: orderId }, sentBy: actor.staffId });
    await recordAudit({
      actor,
      category: 'orders',
      action: body.draft ? 'Saved message draft' : 'Messaged counterparty',
      record: { type: 'order', id: orderId, label: orderId },
      after: { messageId: sent.id, to: sent.user.name, channels: body.channels, deliveredVia: sent.deliveredVia },
      req,
    });
    res.status(201).json({
      id: sent.id,
      deliveredVia: sent.deliveredVia,
      ...(sent.failedChannels.length ? { failedChannels: sent.failedChannels } : {}),
      message: body.draft ? 'Message saved as a draft' : `Message sent to ${sent.user.name}`,
    });
  }, {
    body: z.object({
      subject: z.string().max(200).optional(),
      body: z.string().trim().min(1, 'Write a message').max(1600),
      channels: z.array(z.enum(['sms', 'in_app'])).min(1).default(['in_app']),
      draft: z.boolean().default(false),
    }),
  }),

  route(31, 'GET /orders/intake', ['orders', 'view'], async (req, res) => {
    const s = searchFilter(req.query.q, ['intakeId', 'mineral.name', 'grade']);
    const filter: Record<string, unknown> = { status: { $in: ['pending', 'documents_requested'] } };
    if (s) {
      const users = await User.find({ $or: [{ name: new RegExp(String(req.query.q), 'i') }, { org: new RegExp(String(req.query.q), 'i') }] }).lean();
      filter.$or = [...(s.$or as unknown[]), { userId: { $in: users.map((u) => u.userId) } }];
    }
    res.json(
      await pageOf(IntakeItem, {
        filter,
        sort: { createdAt: 1, _id: 1 },
        paging: paging(req),
        map: async (docs: any[]) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          const [users, files] = await Promise.all([loadUserMap(docs.map((d) => d.userId)), loadFileRefs(docs.flatMap((d) => d.photoFileIds ?? []))]);
          return docs.map((d) => ({
            id: d.intakeId,
            party: partyFrom(users, d.userId),
            mineral: d.mineral?.name,
            quantity: outQty(d.quantity),
            grade: d.grade ?? '',
            liveRate: outUnitPrice(d.liveRate),
            suggested: outMoney(d.suggested),
            documents: (d.documents ?? []).map((x: { id: string; name: string; fileId?: string }) => ({ id: x.id, name: x.name, ...(x.fileId ? { fileId: x.fileId } : {}) })),
            photoCount: (d.photoFileIds ?? []).length,
            photos: (d.photoFileIds ?? []).map((id: string) => files.get(id)).filter(Boolean),
            status: d.status,
          }));
        },
      }),
    );
  }),

  // #32 — money-moving: Idempotency-Key required + four-eyes.
  route(32, 'POST /orders/intake/:intakeId/offer', ['pricing', 'edit'], async (req, res) => {
    const intakeId = String(req.params.intakeId);
    const body = req.body as { deskPrice: { amount: number; currency: string }; validityHours?: number; note?: string; overrideTolerance?: boolean; reason?: string };
    const intake = await IntakeItem.findOne({ intakeId }).lean();
    if (!intake) throw notFound('resource/not-found', `Intake ${intakeId} not found`);
    assertFourEyes(req, [intake.createdBy]);
    if (!['pending', 'documents_requested'].includes(intake.status)) throw conflict('conflict/stale-state', 'A firm offer was already sent for this consignment.', { details: { status: intake.status } });

    const deskPrice = parsePositiveMoney(body.deskPrice, 'deskPrice');
    const platform = await getPlatformValues();
    const suggested = intake.suggested;
    if (suggested && suggested.currency !== deskPrice.currency) throw unprocessable('Currency mismatch', { deskPrice: `Use ${suggested.currency}` });
    const tolerance = platform.instant_estimate_tolerance_pct!;
    const variancePct = suggested?.amountMinor ? (Math.abs(deskPrice.amountMinor - suggested.amountMinor) / suggested.amountMinor) * 100 : 0;
    const overridden = variancePct > tolerance;
    if (overridden) {
      if (!body.overrideTolerance) {
        throw new AppError({ status: 422, code: 'rule/price-outside-tolerance', message: `Desk price is ${variancePct.toFixed(1)}% from the suggested price (tolerance ${tolerance}%).`, details: { suggested: outMoney(suggested), tolerancePct: tolerance } });
      }
      if (!body.reason?.trim()) throw unprocessable('A reason is required to override the tolerance', { reason: 'Required when overriding tolerance' });
    }
    const user = await requireUser(intake.userId);
    const actor = auditActor(req);
    const validityHours = body.validityHours ?? platform.firm_offer_validity_hours!;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + validityHours * MS_HOUR);
    const [offerId, orderId] = [await nextId('offer'), await nextId('orderSell')];

    const auditId = await withTx(async (session) => {
      const claimed = await IntakeItem.findOneAndUpdate({ intakeId, status: { $in: ['pending', 'documents_requested'] } }, { $set: { status: 'offered', offerId, orderId } }, { new: true, session });
      if (!claimed) throw conflict('conflict/stale-state', 'A firm offer was already sent for this consignment.');
      await Order.create(
        [
          {
            orderId,
            side: 'sell',
            status: 'active',
            mineral: intake.mineral,
            grade: intake.grade,
            counterpartyId: intake.userId,
            quantity: intake.quantity,
            stage: 'pricing_confirmation',
            stageEnteredAt: now,
            openedAt: now,
            agentId: actor.staffId,
            value: deskPrice,
            lockedRate: intake.liveRate,
            origin: user.org || user.name,
            destination: 'Mineral Bridge vault',
            route: await defaultRoute('sell', user),
            stageLog: [
              { stage: 'verification', at: now, agentId: actor.staffId, description: 'Bulk consignment verified at intake' },
              { stage: 'pricing_confirmation', at: now, agentId: actor.staffId, description: 'Firm offer sent at manual desk price' },
            ],
            history: [{ text: `Firm offer sent at ${formatMoneyText(outMoney(deskPrice))}`, actorId: actor.staffId, at: now }],
            documents: (intake.documents ?? []).map((d: { id: string; name: string; fileId?: string }) => ({ id: d.id, name: d.name, ref: intakeId, status: 'in_review', fileId: d.fileId })),
            createdBy: actor.staffId,
          },
        ],
        { session },
      );
      await Offer.create(
        [
          {
            offerId,
            orderId,
            userId: intake.userId,
            source: 'intake',
            mineral: intake.mineral,
            declared: intake.quantity,
            rateApplied: intake.liveRate,
            suggested: intake.suggested,
            amount: deskPrice,
            note: body.note ?? '',
            noteKind: overridden ? 'override' : 'clean',
            validityHours,
            status: 'sent',
            decisionReason: body.reason,
            decidedBy: actor.staffId,
            decidedAt: now,
            sentAt: now,
            expiresAt,
            createdBy: actor.staffId,
          },
        ],
        { session },
      );
      return recordAudit({
        actor,
        category: 'pricing',
        action: 'Sent firm offer (bulk intake)',
        record: { type: 'intake', id: intakeId, label: intakeId },
        before: { status: intake.status, suggested: outMoney(suggested) },
        after: { status: 'offered', deskPrice: outMoney(deskPrice), offerId, orderId, validityHours, ...(overridden ? { toleranceOverridden: true } : {}) },
        reason: body.reason ?? body.note,
        req,
        session,
        activity: { text: `Firm offer sent for ${intakeId}`, meta: `${user.org || user.name} · ${formatMoneyText(outMoney(deskPrice))}`, kind: 'intake', ref: { type: 'order', id: orderId } },
      });
    });
    res.json(action({ offerId, expiresAt: expiresAt.toISOString(), orderId }, `Firm offer sent to ${user.org || user.name} · valid ${validityHours} h`, auditId));
  }, {
    idem: 'required',
    body: z.object({
      deskPrice: adminMoneySchema,
      validityHours: z.number().int().min(1).max(168).optional(),
      note: z.string().max(1000).optional(),
      overrideTolerance: z.boolean().optional(),
      reason: z.string().max(1000).optional(),
    }),
  }),

  route(33, 'POST /orders/intake/:intakeId/document-requests', ['orders', 'edit'], async (req, res) => {
    const intakeId = String(req.params.intakeId);
    const body = req.body as { documents: string[]; deadline?: string; note?: string; draft: boolean };
    const intake = await IntakeItem.findOne({ intakeId }).lean();
    if (!intake) throw notFound('resource/not-found', `Intake ${intakeId} not found`);
    if (intake.status === 'offered' || intake.status === 'cancelled') throw conflict('conflict/stale-state', 'This consignment is no longer waiting for documents.');
    const actor = auditActor(req);
    const user = await requireUser(intake.userId);
    const id = await nextId('docRequest');
    const now = new Date();
    const auditId = await withTx(async (session) => {
      await IntakeItem.updateOne(
        { intakeId },
        { $push: { documentRequests: { id, documents: body.documents, deadline: body.deadline, note: body.note, requestedBy: actor.staffId, at: now, draft: body.draft } }, ...(body.draft ? {} : { $set: { status: 'documents_requested' } }) },
        { session },
      );
      if (!body.draft) {
        await sendCustomerMessage({
          userId: intake.userId,
          subject: `Documents needed for ${intakeId}`,
          body: `Please upload: ${body.documents.join(', ')}${body.deadline ? ` by ${body.deadline}` : ''}.${body.note ? ` ${body.note}` : ''}`,
          channels: ['in_app'],
          related: { type: 'intake', id: intakeId },
          sentBy: actor.staffId,
          session,
        });
      }
      return recordAudit({ actor, category: 'orders', action: body.draft ? 'Saved document request draft' : 'Requested more documents', record: { type: 'intake', id: intakeId, label: intakeId }, after: { requestId: id, documents: body.documents, deadline: body.deadline }, reason: body.note, req, session });
    });
    res.status(201).json(action({ id }, body.draft ? 'Document request saved as a draft' : `Document request sent to ${user.org || user.name}`, auditId));
  }, {
    body: z.object({
      documents: z.array(z.string().trim().min(1)).min(1, 'List at least one document'),
      deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
      note: z.string().max(1000).optional(),
      draft: z.boolean().default(false),
    }),
  }),
];

function STAGE_NOTE(label: string): string {
  return `Moved to ${label}`;
}

