import type { Request } from 'express';
import { z } from 'zod';
import { forbidden, notFound } from '../../../common/errors/app-error.js';
import { MODULES, RECORD_TYPES, type PermissionModule } from '../../../models/shared.js';
import { Auction, Listing, Offer, Order, VaultLot } from '../../../models/trading.models.js';
import { LetterOfCredit, Negotiation } from '../../../models/finance.models.js';
import { Dispute, KycDocument, KycSubmission, TierRequest, User } from '../../../models/people.models.js';
import { Ticket } from '../../../models/content.models.js';
import { FileObject, StaffNotification } from '../../../models/platform.models.js';
import { auditActor, hasAccess, staffActor } from '../shared/staff-context.js';
import { recordAudit } from '../../audit/audit.service.js';
import { Role } from '../../auth/auth.models.js';
import { StaffModel } from '../../staff/staff.model.js';
import { ensureReviewFile } from '../../../integration/customer-admin.bridge.js';
import { signFileUrl } from '../../storage/storage.service.js';
import { LOOKUP_TYPES, getLookups, type LookupType } from '../../reference/reference.service.js';
import { ORDER_STAGE_LABEL, type OrderStage } from '../shared/enums.js';
import { boolQ, escapeRegex, iso, paging, searchFilter } from '../shared/http.js';
import { timeAgo } from '../shared/notify.js';
import { route, type AdminRouteDef } from '../shared/route-kit.js';
import { initialsOf } from '../shared/staff-context.js';
import { MS_DAY } from '../shared/enums.js';

const viewable = (req: Request): PermissionModule[] => {
  const a = staffActor(req);
  return MODULES.filter((m) => hasAccess(a.permissions, m, 'view'));
};

/** Which module permission opens a file, by owning record type (#17). */
const FILE_OWNER_MODULE: Record<string, PermissionModule> = {
  order: 'orders', intake: 'orders', lot: 'vault', listing: 'vault', auction: 'auctions', offer: 'pricing',
  kyc: 'compliance', document: 'compliance', dispute: 'compliance', tier_request: 'compliance', user: 'users',
  lc: 'financial', contract: 'financial', settlement: 'financial', ticket: 'support',
  course: 'content', banner: 'content', partner: 'orders',
};

const MODULE_LABEL: Record<string, string> = {
  orders: 'Orders', vault: 'Vault', pricing: 'Pricing', auctions: 'Auctions', users: 'Users', compliance: 'Compliance',
  content: 'Content', financial: 'Financial', settings: 'Settings', support: 'Support',
};

type SearchSource = {
  type: (typeof RECORD_TYPES)[number];
  module: PermissionModule;
  run: (re: RegExp, limit: number) => Promise<Array<{ id: string; title: string; subtitle: string }>>;
};

const searchSources: SearchSource[] = [
  {
    type: 'order', module: 'orders',
    run: async (re, limit) => (await Order.find({ $or: [{ orderId: re }, { 'mineral.name': re }, { grade: re }] }).limit(limit).lean())
      .map((o) => ({ id: o.orderId, title: o.orderId, subtitle: `${o.mineral?.name} · ${o.side} · ${ORDER_STAGE_LABEL[o.stage as OrderStage] ?? o.stage}` })),
  },
  {
    type: 'lot', module: 'vault',
    run: async (re, limit) => (await VaultLot.find({ $or: [{ lotId: re }, { 'mineral.name': re }, { grade: re }] }).limit(limit).lean())
      .map((l) => ({ id: l.lotId, title: l.lotId, subtitle: `${l.mineral?.name} · ${l.grade ?? ''} · ${l.status}` })),
  },
  {
    type: 'listing', module: 'vault',
    run: async (re, limit) => (await Listing.find({ $or: [{ listingId: re }, { lotId: re }, { 'mineral.name': re }] }).limit(limit).lean())
      .map((l) => ({ id: l.listingId, title: l.listingId, subtitle: `${l.mineral?.name} · ${l.status}` })),
  },
  {
    type: 'auction', module: 'auctions',
    run: async (re, limit) => (await Auction.find({ $or: [{ auctionId: re }, { lotId: re }, { 'mineral.name': re }] }).limit(limit).lean())
      .map((a) => ({ id: a.auctionId, title: a.auctionId, subtitle: `${a.mineral?.name} · ${a.status}` })),
  },
  {
    type: 'user', module: 'users',
    run: async (re, limit) => (await User.find({ $or: [{ userId: re }, { name: re }, { org: re }, { email: re }] }).limit(limit).lean())
      .map((u) => ({ id: u.userId, title: u.name, subtitle: `${u.org || '—'} · Tier ${u.tier}` })),
  },
  {
    type: 'document', module: 'compliance',
    run: async (re, limit) => (await KycDocument.find({ $or: [{ docId: re }, { type: re }, { ref: re }] }).limit(limit).lean())
      .map((d) => ({ id: d.docId, title: d.type, subtitle: `${d.ref ?? ''} · ${d.status}` })),
  },
  {
    type: 'ticket', module: 'support',
    run: async (re, limit) => (await Ticket.find({ $or: [{ ticketId: re }, { subject: re }] }).limit(limit).lean())
      .map((t) => ({ id: t.ticketId, title: t.ticketId, subtitle: `${t.subject} · ${t.status}` })),
  },
  {
    type: 'dispute', module: 'compliance',
    run: async (re, limit) => (await Dispute.find({ $or: [{ disputeId: re }, { type: re }] }).limit(limit).lean())
      .map((d) => ({ id: d.disputeId, title: d.disputeId, subtitle: `${d.type} · ${d.status}` })),
  },
  {
    type: 'lc', module: 'financial',
    run: async (re, limit) => (await LetterOfCredit.find({ $or: [{ lcId: re }, { goods: re }, { bankName: re }] }).limit(limit).lean())
      .map((l) => ({ id: l.lcId, title: l.lcId, subtitle: `${l.goods ?? ''} · ${l.status}` })),
  },
  {
    type: 'negotiation', module: 'orders',
    run: async (re, limit) => (await Negotiation.find({ $or: [{ negotiationId: re }, { goods: re }] }).limit(limit).lean())
      .map((n) => ({ id: n.negotiationId, title: n.negotiationId, subtitle: `${n.goods ?? ''} · ${n.status}` })),
  },
];

export const shellRoutes: AdminRouteDef[] = [
  route(13, 'GET /dashboard/counters', 'auth', async (req, res) => {
    const can = new Set(viewable(req));
    const now = new Date();
    const out: Record<string, unknown> = {};
    const jobs: Promise<void>[] = [];
    const add = (module: PermissionModule, fn: () => Promise<void>) => { if (can.has(module)) jobs.push(fn()); };

    add('orders', async () => {
      out.orders = { active: await Order.countDocuments({ status: 'active' }) };
      out.collab = { active: await Negotiation.countDocuments({ status: { $in: ['awaiting_miner', 'awaiting_trader', 'terms_agreed', 'stalled'] } }) };
    });
    add('vault', async () => { out.listings = { live: await Listing.countDocuments({ status: 'live' }) }; });
    add('pricing', async () => { out.pricing = { offersPending: await Offer.countDocuments({ status: 'pending' }) }; });
    add('auctions', async () => {
      const q0 = new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1));
      const [live, upcoming, ended] = await Promise.all([
        Auction.countDocuments({ status: { $in: ['live', 'paused'] } }),
        Auction.countDocuments({ status: 'upcoming' }),
        Auction.countDocuments({ status: 'ended', 'resolution.closedAt': { $gte: q0 } }),
      ]);
      out.auctions = { live, upcoming, endedThisQuarter: ended };
    });
    add('financial', async () => {
      const soon = new Date(now.getTime() + 7 * MS_DAY);
      out.lc = {
        attention: await LetterOfCredit.countDocuments({
          status: { $ne: 'paid' },
          draft: { $ne: true },
          $or: [{ expiry: { $lte: soon } }, { 'discrepancies.status': 'open' }],
        }),
      };
    });
    add('compliance', async () => {
      const [kycQueue, expiringDocs, open] = await Promise.all([
        KycSubmission.countDocuments({ status: { $in: ['in_review', 'expiring_docs', 'awaiting_resubmission'] } }),
        KycDocument.countDocuments({ expiresOn: { $lte: new Date(now.getTime() + 30 * MS_DAY) }, status: { $ne: 'rejected' } }),
        Dispute.countDocuments({ status: { $ne: 'resolved' } }),
      ]);
      out.verification = { kycQueue, expiringDocs };
      out.disputes = { open };
    });
    add('support', async () => { out.support = { openTickets: await Ticket.countDocuments({ status: { $ne: 'resolved' }, isDraft: { $ne: true } }) }; });
    add('users', async () => {
      out.users = { total: await User.estimatedDocumentCount(), tierRequests: await TierRequest.countDocuments({ status: 'pending' }) };
    });
    const a = staffActor(req);
    jobs.push((async () => {
      out.notifications = {
        unread: await StaffNotification.countDocuments({
          module: { $in: [...can] },
          $and: [{ $or: [{ staffId: null }, { staffId: a.staffId }] }, { readBy: { $ne: a.staffId } }],
        }),
      };
    })());
    await Promise.all(jobs);
    res.json(out);
  }),

  route(14, 'GET /search', 'auth', async (req, res) => {
    const q = z.object({
      q: z.string().trim().min(2, 'Enter at least 2 characters'),
      types: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(25).default(5),
    }).parse(req.query);
    const can = new Set(viewable(req));
    const wanted = q.types ? new Set(q.types.split(',').map((t) => t.trim())) : null;
    const re = new RegExp(escapeRegex(q.q), 'i');
    const sources = searchSources.filter((s) => can.has(s.module) && (!wanted || wanted.has(s.type)));
    const groups = (
      await Promise.all(
        sources.map(async (s) => ({
          type: s.type,
          items: (await s.run(re, q.limit)).map((i) => ({ ref: { type: s.type, id: i.id }, title: i.title, subtitle: i.subtitle })),
        })),
      )
    ).filter((g) => g.items.length > 0);
    res.json({ query: q.q, groups });
  }),

  route(15, 'GET /notifications', 'auth', async (req, res) => {
    const q = z.object({ unreadOnly: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(req.query);
    const a = staffActor(req);
    const modules = viewable(req);
    const base = { module: { $in: modules }, $or: [{ staffId: null }, { staffId: a.staffId }] };
    const unreadOnly = boolQ(q.unreadOnly);
    const filter = unreadOnly ? { ...base, readBy: { $ne: a.staffId } } : base;
    const [rows, unread] = await Promise.all([
      StaffNotification.find(filter).sort({ createdAt: -1 }).limit(q.limit).lean(),
      StaffNotification.countDocuments({ ...base, readBy: { $ne: a.staffId } }),
    ]);
    res.json({
      data: rows.map((n) => ({
        id: n.notificationId,
        text: n.text,
        meta: n.meta ?? `${timeAgo(n.createdAt)} · ${MODULE_LABEL[n.module] ?? n.module}`,
        severity: n.severity,
        target: n.target ?? null,
        createdAt: iso(n.createdAt),
        read: (n.readBy ?? []).includes(a.staffId),
      })),
      meta: { unread },
    });
  }),

  route(16, 'POST /notifications/:notificationId/read', 'auth', async (req, res) => {
    const a = staffActor(req);
    const n = await StaffNotification.findOneAndUpdate(
      { notificationId: String(req.params.notificationId), module: { $in: viewable(req) } },
      { $addToSet: { readBy: a.staffId } },
    ).lean();
    if (!n) throw notFound('resource/not-found', 'Notification not found');
    res.status(204).end();
  }),

  route(17, 'GET /files/:fileId/url', 'auth', async (req, res) => {
    const q = z.object({ disposition: z.enum(['inline', 'attachment']).default('inline') }).parse(req.query);
    const a = staffActor(req);
    const fileId = String(req.params.fileId);
    let file = await FileObject.findOne({ fileId }).lean();
    if (!file && (await ensureReviewFile(fileId))) file = await FileObject.findOne({ fileId }).lean();
    if (!file) throw notFound('resource/not-found', 'File not found');
    // Access follows the owning record's module permission; unowned files need settings:view.
    const module = file.owner?.type ? FILE_OWNER_MODULE[file.owner.type] : undefined;
    if (!hasAccess(a.permissions, module ?? 'settings', 'view')) {
      throw forbidden('auth/forbidden', 'Your role cannot open this document');
    }
    const { url, expiresAt } = signFileUrl(file.fileId, q.disposition);
    await recordAudit({
      actor: auditActor(req),
      category: 'compliance',
      action: 'Opened document',
      record: file.owner?.id ? { type: file.owner.type, id: file.owner.id, label: file.name } : { type: 'document', id: file.fileId, label: file.name },
      after: { fileId: file.fileId, disposition: q.disposition },
      req,
    });
    res.json({
      url,
      expiresAt,
      file: { id: file.fileId, name: file.name, mimeType: file.mimeType, sizeBytes: file.sizeBytes, uploadedAt: iso(file.uploadedAt), uploadedBy: file.uploadedBy },
    });
  }),

  route(18, 'GET /lookups', 'auth', async (req, res) => {
    const q = z.object({ types: z.string().optional() }).parse(req.query);
    const types = q.types ? (q.types.split(',').map((t) => t.trim()).filter((t) => (LOOKUP_TYPES as readonly string[]).includes(t)) as LookupType[]) : undefined;
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.json(await getLookups(types));
  }),

  route(19, 'GET /staff', 'auth', async (req, res) => {
    const q = z.object({
      q: z.string().optional(),
      role: z.enum(['field_agent', 'desk', 'compliance', 'support', 'content', 'data_entry']).optional(),
      active: z.string().optional(),
    }).parse(req.query);
    const p = paging(req);
    const filter: Record<string, unknown> = {};
    const active = boolQ(q.active);
    if (active !== undefined) filter.disabled = !active;
    if (q.role) filter['role.id'] = { $in: (await Role.find({ kind: q.role }).lean()).map((r) => r.roleId) };
    const s = searchFilter(q.q, ['name', 'email', 'publicId', 'desk']);
    const where = s ? { $and: [filter, s] } : filter;
    const [rows, total] = await Promise.all([
      StaffModel.find(where).sort({ name: 1 }).skip(p.skip).limit(p.pageSize).lean(),
      StaffModel.countDocuments(where),
    ]);
    const ids = rows.map((r) => r.publicId);
    const [orderAgg, ticketAgg] = await Promise.all([
      Order.aggregate([{ $match: { agentId: { $in: ids }, status: 'active' } }, { $group: { _id: '$agentId', n: { $sum: 1 } } }]),
      Ticket.aggregate([{ $match: { ownerId: { $in: ids }, status: { $ne: 'resolved' } } }, { $group: { _id: '$ownerId', n: { $sum: 1 } } }]),
    ]);
    const open = new Map<string, number>();
    for (const x of [...orderAgg, ...ticketAgg]) open.set(x._id, (open.get(x._id) ?? 0) + x.n);
    res.json({
      data: rows.map((s2) => ({
        id: s2.publicId,
        name: s2.name,
        initials: initialsOf(s2.name),
        role: s2.role?.name ?? '',
        email: s2.email,
        desk: s2.desk ?? '',
        openAssignments: open.get(s2.publicId) ?? 0,
      })),
      meta: { page: p.page, pageSize: p.pageSize, total },
    });
  }),
];

