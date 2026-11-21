import { z } from 'zod';
import { AppError, conflict, notFound, unprocessable } from '../../../common/errors/app-error.js';
import { nextId } from '../../../common/db/sequence.js';
import { withTx } from '../../../common/db/transaction.js';
import { Dispute } from '../../../models/people.models.js';
import { Order } from '../../../models/trading.models.js';
import { recordAudit } from '../../audit/audit.service.js';
import { DISPUTE_OUTCOMES, DISPUTE_STATUSES } from '../shared/enums.js';
import { action, and, daysBetween, iso, oneOf, pageOf, paging, searchFilter, sortSpec } from '../shared/http.js';
import { loadFileRefs } from '../shared/files.js';
import { sendCustomerMessage } from '../shared/messaging.js';
import { notifyStaff } from '../shared/notify.js';
import { adminMoneySchema, formatMoneyText, outMoney, parseMoney } from '../shared/money.js';
import { loadStaffMap, loadUserMap, partyFrom, staffFrom } from '../shared/refs.js';
import { route, type AdminRouteDef } from '../shared/route-kit.js';
import { assertFourEyes, auditActor } from '../shared/staff-context.js';
import { createSettlement } from '../settlements/settlements.service.js';
import { userIdsMatching } from './people.dto.js';

const DISPUTE_SORT: Record<string, string> = { id: 'disputeId', type: 'type', daysOpen: 'openedAt', value: 'valueAtRisk.amountMinor' };

function disputeDto(d: Record<string, any>, users: Map<string, any>) {  
  return {
    id: d.disputeId,
    linked: d.linked?.id ? { type: d.linked.type, id: d.linked.id } : null,
    type: d.type,
    party: partyFrom(users, d.partyId),
    status: d.status,
    daysOpen: daysBetween(d.openedAt, d.status === 'resolved' && d.resolution?.recordedAt ? d.resolution.recordedAt : Date.now()),
    valueAtRisk: outMoney(d.valueAtRisk),
    openedAt: iso(d.openedAt),
  };
}

async function disputeDetail(d: Record<string, any>) {  
  const [users, files, staff] = await Promise.all([loadUserMap([d.partyId]), loadFileRefs(d.attachmentFileIds ?? []), loadStaffMap([d.resolution?.recordedBy])]);
  return {
    ...disputeDto(d, users),
    attachments: (d.attachmentFileIds ?? []).map((id: string) => files.get(id) ?? { id }),
    resolution: d.resolution?.outcome
      ? { outcome: d.resolution.outcome, adjustment: outMoney(d.resolution.adjustment), note: d.resolution.note ?? '', recordedBy: staffFrom(staff, d.resolution.recordedBy), recordedAt: iso(d.resolution.recordedAt) }
      : null,
  };
}

async function requireDispute(disputeId: string) {
  const d = await Dispute.findOne({ disputeId }).lean();
  if (!d) throw notFound('resource/not-found', `Dispute ${disputeId} not found`);
  return d;
}

const resolutionBody = z.object({ outcome: z.enum(DISPUTE_OUTCOMES), adjustment: adminMoneySchema.nullable().optional(), note: z.string().trim().min(3, 'Add a note').max(2000) });

export const disputeRoutes: AdminRouteDef[] = [
  route(102, 'GET /disputes', ['compliance', 'view'], async (req, res) => {
    const status = oneOf(req.query.status, DISPUTE_STATUSES, 'status');
    const ids = await userIdsMatching(req.query.q);
    let search = searchFilter(req.query.q, ['disputeId', 'linked.id', 'type', 'status']);
    if (ids.length) search = { $or: [...((search as { $or: unknown[] } | null)?.$or ?? []), { partyId: { $in: ids } }] };
    const sort = sortSpec(req, DISPUTE_SORT, { openedAt: 1, _id: 1 });
    // "days open" ascending means most recently opened first.
    if (req.query.sort === 'daysOpen') sort.openedAt = (sort.openedAt === 1 ? -1 : 1) as 1 | -1;
    res.json(
      await pageOf(Dispute, {
        filter: and(status && { status }, search),
        sort,
        paging: paging(req),
        map: async (docs: any[]) => {  
          const users = await loadUserMap(docs.map((d) => d.partyId));
          return docs.map((d) => disputeDto(d, users));
        },
      }),
    );
  }),

  route(103, 'GET /disputes/:disputeId', ['compliance', 'view'], async (req, res) => {
    res.json(await disputeDetail(await requireDispute(String(req.params.disputeId))));
  }),

  route(104, 'GET /disputes/:disputeId/messages', ['compliance', 'view'], async (req, res) => {
    const d = await requireDispute(String(req.params.disputeId));
    const files = await loadFileRefs((d.messages ?? []).flatMap((m: { attachmentFileIds?: string[] }) => m.attachmentFileIds ?? []));
    res.json({ data: (d.messages ?? []).map((m: Record<string, any>) => messageDto(m, files)) });  
  }),

  route(105, 'POST /disputes/:disputeId/messages', ['compliance', 'edit'], async (req, res) => {
    const disputeId = String(req.params.disputeId);
    const b = req.body as { text: string; attachmentFileIds: string[] };
    const d = await requireDispute(disputeId);
    if (d.status === 'resolved') throw conflict('conflict/stale-state', `${disputeId} is already resolved.`);
    const files = await loadFileRefs(b.attachmentFileIds);
    const missing = b.attachmentFileIds.filter((id) => !files.has(id));
    if (missing.length) throw unprocessable('Unknown attachment', { attachmentFileIds: `Unknown file: ${missing.join(', ')}` });
    const actor = auditActor(req);
    const now = new Date();
    const msg = await withTx(async (session) => {
      const message = { id: await nextId('disputeMessage', session), from: 'admin', author: actor.name, text: b.text, at: now, attachmentFileIds: b.attachmentFileIds };
      const updated = await Dispute.findOneAndUpdate({ disputeId, status: { $ne: 'resolved' } }, { $push: { messages: message }, ...(d.status === 'evidence_review' ? { $set: { status: 'awaiting_counterparty' } } : {}) }, { new: true, session });
      if (!updated) throw conflict('conflict/stale-state', `${disputeId} was just resolved.`);
      await recordAudit({ actor, category: 'compliance', action: 'Replied on dispute', record: { type: 'dispute', id: disputeId, label: disputeId }, after: { messageId: message.id, attachments: b.attachmentFileIds.length }, req, session });
      return message;
    });
    const party = partyFrom(await loadUserMap([d.partyId]), d.partyId)!;
    if (d.partyId) await sendCustomerMessage({ userId: d.partyId, subject: `Update on ${disputeId}`, body: b.text, channels: ['in_app'], related: { type: 'dispute', id: disputeId }, sentBy: actor.staffId }).catch(() => undefined);
    res.status(201).json({ ...messageDto(msg, files), message: `Reply sent to ${party.org || party.name}` });
  }, { body: z.object({ text: z.string().trim().min(1, 'Write a reply').max(4000), attachmentFileIds: z.array(z.string()).max(10).default([]) }) }),

  // #106 — money-moving: Idempotency-Key required + four-eyes (the staff member who raised it cannot close it).
  route(106, 'POST /disputes/:disputeId/resolution', ['compliance', 'edit'], async (req, res) => {
    const disputeId = String(req.params.disputeId);
    const b = req.body as z.infer<typeof resolutionBody>;
    const d = await requireDispute(disputeId);
    assertFourEyes(req, [d.createdBy, d.raisedBy?.kind === 'staff' ? d.raisedBy.id : undefined]);
    if (d.status === 'resolved') throw conflict('conflict/stale-state', `${disputeId} is already resolved.`, { details: { status: 'resolved' } });
    const adjustment = b.adjustment ? parseMoney(b.adjustment, 'adjustment') : null;
    const adjusts = b.outcome === 'settlement_adjusted' || b.outcome === 'credit_issued';
    if (adjusts && (!adjustment || adjustment.amountMinor === 0)) {
      throw new AppError({ status: 422, code: 'rule/adjustment-required', message: 'This outcome needs a non-zero settlement adjustment.', fields: { adjustment: 'Required' } });
    }
    const actor = auditActor(req);
    const now = new Date();
    const { updated, auditId } = await withTx(async (session) => {
      let settlementId: string | undefined;
      if (adjustment && adjustment.amountMinor !== 0) {
        const order = d.linked?.type === 'order' ? await Order.findOne({ orderId: d.linked.id }, null, { session }).lean() : null;
        const sid = await createSettlement({ kind: order?.side === 'sell' ? 'seller_payout' : 'buy_settlement', ref: { type: 'dispute', id: disputeId }, partyId: d.partyId, amount: adjustment, status: 'released', rail: 'bank', createdBy: actor.staffId, date: now, session });
        settlementId = sid;
      }
      const updated = await Dispute.findOneAndUpdate(
        { disputeId, status: { $ne: 'resolved' } },
        { $set: { status: 'resolved', resolution: { outcome: b.outcome, adjustment: adjustment ?? undefined, note: b.note, recordedBy: actor.staffId, recordedAt: now, settlementId } } },
        { new: true, session },
      ).lean();
      if (!updated) throw conflict('conflict/stale-state', `${disputeId} was just resolved.`);
      const auditId = await recordAudit({ actor, category: 'compliance', action: 'Recorded dispute resolution', record: { type: 'dispute', id: disputeId, label: disputeId }, before: { status: d.status }, after: { status: 'resolved', outcome: b.outcome, adjustment: outMoney(adjustment), settlementId }, reason: b.note, req, session, activity: { text: `Dispute ${disputeId} resolved`, meta: b.outcome.replace('_', ' '), kind: 'dispute', ref: { type: 'dispute', id: disputeId } } });
      return { updated, auditId };
    });
    if (d.partyId) await sendCustomerMessage({ userId: d.partyId, subject: `${disputeId} resolved`, body: `Outcome: ${b.outcome.replace(/_/g, ' ')}${adjustment ? ` (${formatMoneyText(outMoney(adjustment))})` : ''}. ${b.note}`, channels: ['in_app'], related: { type: 'dispute', id: disputeId }, sentBy: actor.staffId }).catch(() => undefined);
    res.json(action(await disputeDetail(updated), `Resolution recorded on ${disputeId} — counterparty notified`, auditId));
  }, { idem: 'required', body: resolutionBody }),

  route(107, 'POST /disputes/:disputeId/escalate', ['compliance', 'edit'], async (req, res) => {
    const disputeId = String(req.params.disputeId);
    const { note } = req.body as { note?: string };
    const d = await requireDispute(disputeId);
    if (d.status === 'resolved' || d.status === 'compliance_hold') throw conflict('conflict/stale-state', `${disputeId} is already ${d.status.replace('_', ' ')}.`, { details: { status: d.status } });
    const actor = auditActor(req);
    const now = new Date();
    const { updated, auditId } = await withTx(async (session) => {
      const msg = note ? { id: await nextId('disputeMessage', session), from: 'admin', author: actor.name, text: `Escalated to compliance: ${note}`, at: now } : null;
      const updated = await Dispute.findOneAndUpdate({ disputeId, status: { $in: ['evidence_review', 'awaiting_counterparty'] } }, { $set: { status: 'compliance_hold', escalatedAt: now }, ...(msg ? { $push: { messages: msg } } : {}) }, { new: true, session }).lean();
      if (!updated) throw conflict('conflict/stale-state', `${disputeId} changed state — refresh and try again.`);
      const auditId = await recordAudit({ actor, category: 'compliance', action: 'Escalated dispute to compliance hold', record: { type: 'dispute', id: disputeId, label: disputeId }, before: { status: d.status }, after: { status: 'compliance_hold' }, reason: note, req, session, activity: { text: `Dispute ${disputeId} escalated to compliance`, kind: 'dispute', severity: 'warn', ref: { type: 'dispute', id: disputeId } } });
      return { updated, auditId };
    });
    await notifyStaff({ module: 'compliance', text: `${disputeId} escalated to compliance hold`, meta: note, severity: 'high', target: { type: 'dispute', id: disputeId } });
    res.json(action(await disputeDetail(updated), `${disputeId} escalated to compliance`, auditId));
  }, { body: z.object({ note: z.string().trim().max(1000).optional() }).default({}) }),
];

function messageDto(m: Record<string, any>, files: Map<string, any>) {  
  return { id: m.id, from: m.from, author: m.author ?? '', text: m.text, at: iso(m.at), ...(m.attachmentFileIds?.length ? { attachments: m.attachmentFileIds.map((id: string) => files.get(id) ?? { id }) } : {}) };
}
