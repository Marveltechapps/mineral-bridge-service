import { z } from 'zod';
import { AppError, conflict, notFound } from '../../../common/errors/app-error.js';
import { withTx } from '../../../common/db/transaction.js';
import { KycDocument, KycSubmission, User } from '../../../models/people.models.js';
import { recordAudit } from '../../audit/audit.service.js';
import { KYC_OPEN_STATUSES, KYC_STATUSES, MS_DAY } from '../shared/enums.js';
import { action, and, iso, oneOf, pageOf, paging, searchFilter, sortSpec } from '../shared/http.js';
import { sendCustomerMessage } from '../shared/messaging.js';
import { loadStaffMap, loadUserMap, staffFrom } from '../shared/refs.js';
import { route, type AdminRouteDef } from '../shared/route-kit.js';
import { auditActor } from '../shared/staff-context.js';
import { applyAdminKycToCustomer, backfillAdminKycFiles } from '../../../integration/customer-admin.bridge.js';
import { KYC_SLA_MS, trackedDocumentDto, userIdsMatching } from './people.dto.js';

const DOC_SORT: Record<string, string> = { type: 'type', holder: 'userId', tier: 'tier', daysToExpiry: 'expiresOn', status: 'status' };

function kycDto(k: Record<string, any>, docs: Array<Record<string, any>>) {  
  const slaDueAt: Date = k.slaDueAt ?? new Date(new Date(k.submittedAt).getTime() + KYC_SLA_MS);
  const open = (KYC_OPEN_STATUSES as readonly string[]).includes(k.status);
  return {
    id: k.kycId,
    person: k.person ?? '',
    org: k.org ?? '',
    userId: k.userId,
    tier: k.tier,
    submittedAt: iso(k.submittedAt),
    slaDueAt: iso(slaDueAt),
    overdue: open && slaDueAt.getTime() < Date.now(),
    status: k.status,
    documents: docs.map((d) => ({
      id: d.docId,
      name: d.name ?? d.type,
      ref: d.ref ?? '',
      status: d.status,
      fileId: d.fileId ?? null,
      side: d.side ?? null,
      mimeType: d.mimeType ?? null,
      rejectionReason: d.rejectionReason ?? null,
    })),
  };
}

async function docsFor(kycIds: string[]) {
  const docs = await KycDocument.find({ kycId: { $in: kycIds } }).sort({ createdAt: 1 }).lean();
  const byKyc = new Map<string, Array<Record<string, any>>>();  
  for (const d of docs) byKyc.set(d.kycId, [...(byKyc.get(d.kycId) ?? []), d]);
  return byKyc;
}

const decisionBody = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve') }),
  z.object({ decision: z.literal('request_resubmission'), documents: z.array(z.string()).max(50).default([]), reason: z.string().trim().min(3, 'Say what needs resubmitting').max(1000) }),
  z.object({ decision: z.literal('reject'), reason: z.string().trim().min(3, 'Give a reason').max(1000) }),
]);

export const complianceRoutes: AdminRouteDef[] = [
  route(98, 'GET /compliance/kyc', ['compliance', 'view'], async (req, res) => {
    const tier = oneOf(req.query.tier, ['1', '2', '3'] as const, 'tier');
    const status = oneOf(req.query.status, KYC_STATUSES, 'status');
    const overdue = req.query.overdueSla === 'true';
    let search = searchFilter(req.query.q, ['kycId', 'org', 'person']);
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (/^[123]$/.test(q)) search = { $or: [...((search as { $or: unknown[] }).$or), { tier: Number(q) }] };
    const open = { status: { $in: [...KYC_OPEN_STATUSES] } };
    const filter = and(status ? { status } : open, tier && { tier: Number(tier) }, overdue && { ...open, slaDueAt: { $lt: new Date() } }, search);
    res.json(
      await pageOf(KycSubmission, {
        filter,
        sort: sortSpec(req, { id: 'kycId', tier: 'tier', submittedAt: 'submittedAt' }, { submittedAt: 1, _id: 1 }),
        paging: paging(req),
        map: async (docs: any[]) => {  
          await Promise.all(docs.map((d) => backfillAdminKycFiles(d.kycId)));
          const byKyc = await docsFor(docs.map((d) => d.kycId));
          return docs.map((d) => kycDto(d, byKyc.get(d.kycId) ?? []));
        },
      }),
    );
  }),

  route(99, 'GET /compliance/kyc/:kycId', ['compliance', 'view'], async (req, res) => {
    const k = await KycSubmission.findOne({ kycId: String(req.params.kycId) }).lean();
    if (!k) throw notFound('resource/not-found', `KYC submission ${req.params.kycId} not found`);
    await backfillAdminKycFiles(k.kycId);
    const [byKyc, staff] = await Promise.all([docsFor([k.kycId]), loadStaffMap((k.history ?? []).map((h: { actorId?: string }) => h.actorId))]);
    res.json({ ...kycDto(k, byKyc.get(k.kycId) ?? []), history: (k.history ?? []).map((h: Record<string, any>) => ({ action: h.action, actor: h.actorId ? staffFrom(staff, h.actorId) : null, at: iso(h.at), ...(h.reason ? { reason: h.reason } : {}) })) });  
  }),

  route(100, 'POST /compliance/kyc/:kycId/decision', ['compliance', 'edit'], async (req, res) => {
    const kycId = String(req.params.kycId);
    const b = req.body as z.infer<typeof decisionBody>;
    const k = await KycSubmission.findOne({ kycId }).lean();
    if (!k) throw notFound('resource/not-found', `KYC submission ${kycId} not found`);
    if (!(KYC_OPEN_STATUSES as readonly string[]).includes(k.status)) throw conflict('conflict/stale-state', `${kycId} is already ${k.status.replace('_', ' ')}.`, { details: { status: k.status } });
    const docs = await KycDocument.find({ kycId }).lean();
    if (b.decision === 'approve') {
      const rejected = docs.filter((d) => d.status === 'rejected');
      if (rejected.length) {
        throw new AppError({
          status: 422,
          code: 'rule/documents-unverified',
          message: `${rejected.length} document${rejected.length === 1 ? ' is' : 's are'} still rejected. Request a resubmission before approving.`,
          details: { documents: rejected.map((d) => d.docId) },
        });
      }
    }
    const actor = auditActor(req);
    const now = new Date();
    const person = k.person || k.userId;
    const { auditId } = await withTx(async (session) => {
      const status = b.decision === 'approve' ? 'verified' : b.decision === 'reject' ? 'rejected' : 'awaiting_resubmission';
      const updated = await KycSubmission.findOneAndUpdate(
        { kycId, status: { $in: [...KYC_OPEN_STATUSES] } },
        { $set: { status, decidedBy: actor.staffId, decidedAt: now }, $push: { history: { action: b.decision === 'approve' ? `Tier ${k.tier} approved` : b.decision === 'reject' ? 'Rejected' : 'Resubmission requested', actorId: actor.staffId, at: now, ...(b.decision !== 'approve' ? { reason: b.reason } : {}) } } },
        { new: true, session },
      ).lean();
      if (!updated) throw conflict('conflict/stale-state', `${kycId} was just decided by someone else.`);
      if (b.decision === 'approve') {
        await KycDocument.updateMany({ kycId, status: 'in_review' }, { $set: { status: 'verified' }, $unset: { rejectionReason: '' } }, { session });
        await User.updateOne({ userId: k.userId }, { $set: { tier: k.tier, status: 'verified', kycStatus: 'verified' } }, { session });
      } else if (b.decision === 'reject') {
        await KycDocument.updateMany({ kycId }, { $set: { status: 'rejected', rejectionReason: b.reason } }, { session });
        await User.updateOne({ userId: k.userId }, { $set: { status: 'rejected', kycStatus: 'rejected' } }, { session });
      } else {
        const targets = b.documents.length ? b.documents : docs.filter((d) => d.status !== 'verified').map((d) => d.docId);
        await KycDocument.updateMany({ kycId, docId: { $in: targets } }, { $set: { status: 'rejected', rejectionReason: b.reason } }, { session });
        await User.updateOne({ userId: k.userId }, { $set: { kycStatus: 'pending' } }, { session });
      }
      const auditId = await recordAudit({
        actor,
        category: 'compliance',
        action: b.decision === 'approve' ? `Approved Tier ${k.tier} KYC` : b.decision === 'reject' ? 'Rejected KYC submission' : 'Requested KYC resubmission',
        record: { type: 'kyc', id: kycId, label: `${kycId} · ${person}` },
        before: { status: k.status },
        after: { status, ...(b.decision === 'request_resubmission' ? { documents: b.documents } : {}) },
        reason: b.decision === 'approve' ? undefined : b.reason,
        req,
        session,
        activity: { text: b.decision === 'approve' ? `Tier ${k.tier} approved for ${person}` : b.decision === 'reject' ? `${kycId} rejected` : `Resubmission requested from ${person}`, kind: 'kyc', ref: { type: 'kyc', id: kycId } },
      });
      return { auditId };
    });
    await applyAdminKycToCustomer({
      kycId,
      staffId: actor.staffId,
      decision: b.decision,
      reason: b.decision === 'approve' ? undefined : b.reason,
      documentIds: b.decision === 'request_resubmission' ? b.documents : undefined,
    });
    const text = b.decision === 'approve' ? `Your Tier ${k.tier} verification is approved.` : b.decision === 'reject' ? `Your verification was not approved: ${b.reason}` : `Please resubmit your documents: ${b.reason}`;
    await sendCustomerMessage({ userId: k.userId, subject: 'Verification update', body: text, channels: ['in_app'], related: { type: 'kyc', id: kycId }, sentBy: actor.staffId }).catch(() => undefined);
    const fresh = await KycSubmission.findOne({ kycId }).lean();
    const byKyc = await docsFor([kycId]);
    res.json(action(kycDto(fresh!, byKyc.get(kycId) ?? []), b.decision === 'approve' ? `Tier ${k.tier} approved for ${person}` : b.decision === 'reject' ? `${kycId} rejected — reason sent to ${person}` : `Resubmission requested from ${person}`, auditId));
  }, { body: decisionBody }),

  route(101, 'GET /compliance/documents', ['compliance', 'view'], async (req, res) => {
    const expiry = oneOf(req.query.expiry, ['expired', 'lt30', 'lt90'] as const, 'expiry');
    const status = oneOf(req.query.status, ['in_review', 'verified', 'rejected', 'expiring', 'expired'] as const, 'status');
    const now = new Date();
    const at = (days: number) => new Date(now.getTime() + days * MS_DAY);
    const expiryFilter = expiry === 'expired' ? { expiresOn: { $lt: now } } : expiry === 'lt30' ? { expiresOn: { $gte: now, $lt: at(30) } } : expiry === 'lt90' ? { expiresOn: { $gte: now, $lt: at(90) } } : null;
    const ids = await userIdsMatching(req.query.q);
    let search = searchFilter(req.query.q, ['docId', 'type', 'ref', 'status']);
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (/^[123]$/.test(q)) search = { $or: [...((search as { $or: unknown[] }).$or), { tier: Number(q) }] };
    if (ids.length) search = { $or: [...((search as { $or: unknown[] } | null)?.$or ?? []), { userId: { $in: ids } }] };
    const statusFilter = status === 'expired' ? { expiresOn: { $lt: now } } : status === 'expiring' ? { status: 'verified', expiresOn: { $gte: now, $lt: at(35) } } : status ? { status } : null;
    const filter = and(!status || status !== 'in_review' ? { expiresOn: { $exists: true, $ne: null } } : null, expiryFilter, statusFilter, search);
    res.json(
      await pageOf(KycDocument, {
        filter,
        sort: sortSpec(req, DOC_SORT, { expiresOn: 1, _id: 1 }),
        paging: paging(req),
        map: async (docs: any[]) => {  
          const holders = await loadUserMap(docs.map((d) => d.userId));
          return docs.map((d) => trackedDocumentDto(d, holders));
        },
        extraMeta: async () => ({
          counts: {
            expiringWithin35: await KycDocument.countDocuments({ expiresOn: { $gte: now, $lt: at(35) } }),
            expired: await KycDocument.countDocuments({ expiresOn: { $lt: now } }),
          },
        }),
      }),
    );
  }),
];
