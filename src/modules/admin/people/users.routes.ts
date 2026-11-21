import { z } from 'zod';
import { AppError, conflict, notFound } from '../../../common/errors/app-error.js';
import { nextId } from '../../../common/db/sequence.js';
import { withTx } from '../../../common/db/transaction.js';
import { Ticket } from '../../../models/content.models.js';
import { Dispute, KycDocument, KycSubmission, TierRequest, User } from '../../../models/people.models.js';
import { Order } from '../../../models/trading.models.js';
import { recordAudit } from '../../audit/audit.service.js';
import { ACCOUNT_STATUSES } from '../shared/enums.js';
import { action, and, boolQ, escapeRegex, iso, oneOf, pageOf, paging, sendCsv, sortSpec, toCsv, isoDate } from '../shared/http.js';
import { sendCustomerMessage } from '../shared/messaging.js';
import { notifyStaff } from '../shared/notify.js';
import { outMoneyOrZero } from '../shared/money.js';
import { loadStaffMap, loadUserMap, partyFrom, requireUser } from '../shared/refs.js';
import { route, type AdminRouteDef } from '../shared/route-kit.js';
import { auditActor, hasAccess, staffActor } from '../shared/staff-context.js';
import { mapOrderSummaries } from '../orders/orders.service.js';
import { KYC_SLA_MS, maskPhoneNumber, ticketDto, trackedDocumentDto, userSummaryDto } from './people.dto.js';

const USER_SORT: Record<string, string> = { name: 'name', tier: 'tier', status: 'status', orders: 'orderCount', joined: 'createdAt' };

function userFilter(req: import('express').Request) {
  const tier = oneOf(req.query.tier, ['1', '2', '3'] as const, 'tier');
  const status = oneOf(req.query.status, ACCOUNT_STATUSES, 'status');
  const verifiedOnly = boolQ(req.query.verifiedOnly);
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const re = q ? new RegExp(escapeRegex(q), 'i') : null;
  return and(tier && { tier: Number(tier) }, status && { status }, verifiedOnly && { status: 'verified' }, re && { $or: [{ name: re }, { org: re }, { email: re }, { phone: re }, { userId: re }] });
}

const ORDER_COUNT_STAGES = [
  { $lookup: { from: Order.collection.name, localField: 'userId', foreignField: 'counterpartyId', pipeline: [{ $match: { status: { $ne: 'draft' } } }, { $count: 'n' }], as: 'oc' } },
  { $addFields: { orderCount: { $ifNull: [{ $arrayElemAt: ['$oc.n', 0] }, 0] } } },
  { $project: { oc: 0 } },
];

async function listUsers(req: import('express').Request, p: { skip: number; pageSize: number }) {
  const filter = userFilter(req);
  const sort = sortSpec(req, USER_SORT, { name: 1, _id: 1 });
  const [rows, total] = await Promise.all([
    User.aggregate([{ $match: filter }, ...ORDER_COUNT_STAGES, { $sort: sort }, { $skip: p.skip }, { $limit: p.pageSize }]),
    User.countDocuments(filter),
  ]);
  return { rows, total };
}

const piiAllowed = (req: import('express').Request) => hasAccess(staffActor(req).permissions, 'users', 'edit');

function tierRequestDto(t: Record<string, any>, users: Map<string, any>) {  
  return { id: t.requestId, user: partyFrom(users, t.userId), from: t.from, to: t.to, reason: t.reason ?? '', openedAt: iso(t.openedAt), status: t.status };
}

async function lifetimeValue(userId: string) {
  const rows = await Order.aggregate([{ $match: { counterpartyId: userId, status: { $in: ['active', 'completed'] }, 'value.currency': 'USD', $or: [{ priceConfirmedAt: { $type: 'date' } }, { paymentStatus: 'released' }] } }, { $group: { _id: null, minor: { $sum: '$value.amountMinor' } } }]);
  if (!rows[0]) return null;
  return outMoneyOrZero({ amountMinor: rows[0].minor ?? 0, currency: 'USD', scale: 2 });
}

export const userRoutes: AdminRouteDef[] = [
  route(88, 'GET /users', ['users', 'view'], async (req, res) => {
    const p = paging(req);
    const { rows, total } = await listUsers(req, p);
    const pii = piiAllowed(req);
    res.json({ data: rows.map((u) => userSummaryDto(u, u.orderCount ?? 0, pii)), meta: { page: p.page, pageSize: p.pageSize, total } });
  }),

  route(89, 'GET /users/export', ['users', 'view'], async (req, res) => {
    const { rows } = await listUsers(req, { skip: 0, pageSize: 50_000 });
    const pii = piiAllowed(req);
    await recordAudit({ actor: auditActor(req), category: 'compliance', action: 'Exported user list', record: { type: 'user', id: 'export', label: 'User list export' }, after: { rows: rows.length, filter: req.query, maskedPii: !pii }, req });
    sendCsv(res, `users-${isoDate()}.csv`, toCsv(['user_id', 'name', 'organisation', 'email', 'tier', 'status', 'orders', 'joined_at'], rows.map((u) => { const d = userSummaryDto(u, u.orderCount ?? 0, pii); return [d.id, d.name, d.org, d.email, d.tier, d.status, d.orderCount, d.joinedAt]; })));
  }),

  route(90, 'GET /users/:userId', ['users', 'view'], async (req, res) => {
    const u = await requireUser(String(req.params.userId));
    const [orderCount, openDisputes, ltv] = await Promise.all([
      Order.countDocuments({ counterpartyId: u.userId, status: { $ne: 'draft' } }),
      Dispute.countDocuments({ partyId: u.userId, status: { $ne: 'resolved' } }),
      lifetimeValue(u.userId),
    ]);
    const pii = piiAllowed(req);
    res.json({ ...userSummaryDto(u, orderCount, pii), phone: pii ? u.phone ?? '' : maskPhoneNumber(u.phone), lifetimeValue: ltv, openDisputes, country: u.country ?? '' });
  }),

  route(91, 'GET /users/:userId/orders', ['users', 'view'], async (req, res) => {
    const u = await requireUser(String(req.params.userId));
    res.json(
      await pageOf(Order, {
        filter: { counterpartyId: u.userId, status: { $ne: 'draft' } },
        sort: { openedAt: -1, _id: 1 },
        paging: paging(req),
        map: (docs: any[]) => mapOrderSummaries(docs),  
        extraMeta: async () => ({ lifetimeValue: await lifetimeValue(u.userId) }),
      }),
    );
  }),

  route(92, 'GET /users/:userId/tickets', ['users', 'view'], async (req, res) => {
    const u = await requireUser(String(req.params.userId));
    res.json(
      await pageOf(Ticket, {
        filter: { userId: u.userId, isDraft: { $ne: true } },
        sort: { openedAt: -1, _id: 1 },
        paging: paging(req),
        map: async (docs: any[]) => {  
          const [users, staff] = await Promise.all([loadUserMap([u.userId]), loadStaffMap(docs.map((d) => d.ownerId))]);
          return docs.map((d) => ticketDto(d, users, staff));
        },
      }),
    );
  }),

  route(93, 'GET /users/:userId/documents', ['users', 'view'], async (req, res) => {
    const u = await requireUser(String(req.params.userId));
    res.json(
      await pageOf(KycDocument, {
        filter: { userId: u.userId },
        sort: { expiresOn: 1, _id: 1 },
        paging: paging(req),
        map: async (docs: any[]) => {  
          const holders = await loadUserMap([u.userId]);
          return docs.map((d) => trackedDocumentDto(d, holders));
        },
      }),
    );
  }),

  route(94, 'POST /users/:userId/messages', ['users', 'edit'], async (req, res) => {
    const u = await requireUser(String(req.params.userId));
    const body = req.body as { subject?: string; body: string; channels: Array<'sms' | 'in_app'>; draft: boolean };
    const actor = auditActor(req);
    const sent = await sendCustomerMessage({ userId: u.userId, subject: body.subject, body: body.body, channels: body.channels, draft: body.draft, related: { type: 'user', id: u.userId }, sentBy: actor.staffId });
    await recordAudit({ actor, category: 'compliance', action: body.draft ? 'Saved message draft' : 'Messaged user', record: { type: 'user', id: u.userId, label: u.name }, after: { messageId: sent.id, channels: body.channels, deliveredVia: sent.deliveredVia }, req });
    res.status(201).json({ id: sent.id, deliveredVia: sent.deliveredVia, ...(sent.failedChannels.length ? { failedChannels: sent.failedChannels } : {}), message: body.draft ? 'Message saved as a draft' : `Message sent to ${u.name}` });
  }, {
    body: z.object({
      subject: z.string().max(200).optional(),
      body: z.string().trim().min(1, 'Write a message').max(1600),
      channels: z.array(z.enum(['sms', 'in_app'])).min(1).default(['in_app']),
      draft: z.boolean().default(false),
    }),
  }),

  route(95, 'POST /tier-requests', ['users', 'edit'], async (req, res) => {
    const b = req.body as { userId: string; toTier: 1 | 2 | 3; reason: string; raisedBy: 'admin' | 'user' };
    const u = await requireUser(b.userId);
    if (u.tier === b.toTier) throw new AppError({ status: 422, code: 'rule/same-tier', message: `${u.name} is already Tier ${u.tier}.`, fields: { toTier: 'Same as current tier' } });
    const actor = auditActor(req);
    const { created, auditId } = await withTx(async (session) => {
      const requestId = await nextId('tierRequest', session);
      let created;
      try {
        [created] = await TierRequest.create([{ requestId, userId: u.userId, from: u.tier, to: b.toTier, reason: b.reason, raisedBy: b.raisedBy === 'admin' ? actor.staffId : u.userId, status: 'pending', openedAt: new Date() }], { session });
      } catch (err) {
        if ((err as { code?: number }).code === 11000) throw conflict('conflict/duplicate', `${u.name} already has a pending tier request.`);
        throw err;
      }
      const auditId = await recordAudit({ actor, category: 'compliance', action: 'Raised tier change request', record: { type: 'tier_request', id: requestId, label: `${u.name} → Tier ${b.toTier}` }, after: { userId: u.userId, from: u.tier, to: b.toTier }, reason: b.reason, req, session });
      return { created: created!.toObject(), auditId };
    });
    await notifyStaff({ module: 'compliance', text: `Tier change for ${u.name}: Tier ${u.tier} → Tier ${b.toTier}`, meta: b.reason, severity: 'medium', target: { type: 'tier_request', id: created.requestId } });
    res.status(201).json(action(tierRequestDto(created, await loadUserMap([u.userId])), `Tier change sent to compliance for ${u.name}`, auditId));
  }, { body: z.object({ userId: z.string().min(1), toTier: z.union([z.literal(1), z.literal(2), z.literal(3)]), reason: z.string().trim().min(3).max(1000), raisedBy: z.enum(['admin', 'user']).default('admin') }) }),

  route(96, 'GET /tier-requests', ['users', 'view'], async (req, res) => {
    const status = oneOf(req.query.status, ['pending', 'approved', 'denied'] as const, 'status') ?? 'pending';
    res.json(
      await pageOf(TierRequest, {
        filter: { status },
        sort: { openedAt: status === 'pending' ? 1 : -1, _id: 1 },
        paging: paging(req),
        map: async (docs: any[]) => {  
          const users = await loadUserMap(docs.map((d) => d.userId));
          return docs.map((d) => tierRequestDto(d, users));
        },
      }),
    );
  }),

  route(97, 'POST /tier-requests/:requestId/decision', ['compliance', 'edit'], async (req, res) => {
    const requestId = String(req.params.requestId);
    const b = req.body as { decision: 'approve' } | { decision: 'deny'; reason: string };
    const t = await TierRequest.findOne({ requestId }).lean();
    if (!t) throw notFound('resource/not-found', `Tier request ${requestId} not found`);
    if (t.status !== 'pending') throw conflict('conflict/stale-state', `${requestId} was already ${t.status}.`, { details: { status: t.status } });
    const u = await requireUser(t.userId);
    const actor = auditActor(req);
    const now = new Date();
    const approve = b.decision === 'approve';
    const { updated, kycId, auditId } = await withTx(async (session) => {
      const updated = await TierRequest.findOneAndUpdate({ requestId, status: 'pending' }, { $set: { status: approve ? 'approved' : 'denied', decidedBy: actor.staffId, decidedAt: now, ...(b.decision === 'deny' ? { decisionReason: b.reason } : {}) } }, { new: true, session }).lean();
      if (!updated) throw conflict('conflict/stale-state', `${requestId} was already decided.`);
      let kycId: string | undefined;
      if (approve) {
        await User.updateOne({ userId: t.userId }, { $set: { tier: t.to } }, { session });
        const covered = await KycSubmission.exists({ userId: t.userId, status: 'verified', tier: { $gte: t.to } }).session(session ?? null);
        if (!covered) {
          kycId = await nextId('kyc', session);
          await KycSubmission.create([{ kycId, userId: t.userId, person: u.name, org: u.org, tier: t.to, submittedAt: now, slaDueAt: new Date(now.getTime() + KYC_SLA_MS), status: 'in_review', history: [{ action: `Opened for Tier ${t.to} (request ${requestId})`, actorId: actor.staffId, at: now }] }], { session });
          await TierRequest.updateOne({ requestId }, { $set: { kycId } }, { session });
        }
      }
      const auditId = await recordAudit({ actor, category: 'compliance', action: approve ? 'Approved tier change' : 'Denied tier change', record: { type: 'tier_request', id: requestId, label: `${u.name} → Tier ${t.to}` }, before: { tier: t.from }, after: approve ? { tier: t.to, kycId } : { status: 'denied' }, reason: b.decision === 'deny' ? b.reason : undefined, req, session, activity: { text: approve ? `${u.name} moved to Tier ${t.to}` : `${u.name}'s tier request denied`, kind: 'user', ref: { type: 'user', id: u.userId } } });
      return { updated, kycId, auditId };
    });
    await sendCustomerMessage({ userId: u.userId, subject: approve ? `You are now Tier ${t.to}` : 'Tier request update', body: approve ? `Your account has been upgraded to Tier ${t.to}.${kycId ? ' Please upload the documents requested for this tier.' : ''}` : `Your tier request was not approved: ${(b as { reason: string }).reason}`, channels: ['in_app'], related: { type: 'user', id: u.userId }, sentBy: actor.staffId }).catch(() => undefined);
    const users = await loadUserMap([u.userId]);
    res.json(action({ ...tierRequestDto(updated, users), ...(kycId ? { kycId } : {}) }, approve ? `${u.name} moved to Tier ${t.to}` : `${u.name}'s tier request denied`, auditId));
  }, { body: z.discriminatedUnion('decision', [z.object({ decision: z.literal('approve') }), z.object({ decision: z.literal('deny'), reason: z.string().trim().min(3, 'Give a reason').max(1000) })]) }),
];

