import { z } from 'zod';
import { conflict, notFound } from '../../../common/errors/app-error.js';
import { nextId } from '../../../common/db/sequence.js';
import { withTx } from '../../../common/db/transaction.js';
import { Partner } from '../../../models/content.models.js';
import { Order } from '../../../models/trading.models.js';
import { recordAudit } from '../../audit/audit.service.js';
import { PARTNER_STATUSES, PARTNER_TYPES } from '../shared/enums.js';
import { action, and, escapeRegex, oneOf } from '../shared/http.js';
import { route, type AdminRouteDef } from '../shared/route-kit.js';
import { auditActor } from '../shared/staff-context.js';

const GROUP_LABEL: Record<string, string> = { bonded_carrier: 'Bonded carriers', inspection_hub: 'Inspection hubs', lab_assay: 'Assay labs' };
const ORDER_FIELD: Record<string, string> = { bonded_carrier: 'carrierId', inspection_hub: 'hubId', lab_assay: 'labId' };

async function usage(partners: Array<Record<string, any>>) {  
  const total = new Map<string, number>();
  const active = new Map<string, number>();
  await Promise.all(
    (['carrierId', 'hubId', 'labId'] as const).map(async (field) => {
      const ids = partners.filter((p) => ORDER_FIELD[p.type] === field).map((p) => p.partnerId);
      if (!ids.length) return;
      const rows = await Order.aggregate([{ $match: { [field]: { $in: ids }, status: { $in: ['active', 'completed'] } } }, { $group: { _id: { id: `$${field}`, status: '$status' }, n: { $sum: 1 } } }]);
      for (const r of rows) {
        total.set(r._id.id, (total.get(r._id.id) ?? 0) + r.n);
        if (r._id.status === 'active') active.set(r._id.id, r.n);
      }
    }),
  );
  return { total, active };
}

function partnerDto(p: Record<string, any>, total: number, active: number) {  
  const unit = p.type === 'lab_assay' ? 'assays' : 'orders';
  return {
    id: p.partnerId,
    name: p.name,
    type: p.type,
    base: p.base ?? '',
    capacity: p.capacity ?? '',
    email: p.email ?? '',
    phone: p.phone ?? '',
    ...(p.accreditation ? { accreditation: p.accreditation } : {}),
    status: p.status,
    volume: { count: total, unit },
    note: active ? `${active} ${unit === 'assays' ? 'assays' : 'orders'} in progress` : p.status === 'onboarding' ? 'Onboarding' : 'No active work',
    ...(p.internalNote ? { internalNote: p.internalNote } : {}),
  };
}

export const partnerRoutes: AdminRouteDef[] = [
  route(116, 'GET /partners', ['orders', 'view'], async (req, res) => {
    const type = oneOf(req.query.type, PARTNER_TYPES, 'type');
    const status = oneOf(req.query.status, PARTNER_STATUSES, 'status');
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const re = q ? new RegExp(escapeRegex(q), 'i') : null;
    const partners = await Partner.find(and(type && { type }, status && { status }, re && { $or: [{ name: re }, { base: re }, { email: re }, { phone: re }, { status: re }] })).sort({ name: 1, _id: 1 }).lean();
    const u = await usage(partners);
    res.json({
      groups: PARTNER_TYPES.filter((t) => !type || t === type).map((t) => ({ type: t, label: GROUP_LABEL[t], partners: partners.filter((p) => p.type === t).map((p) => partnerDto(p, u.total.get(p.partnerId) ?? 0, u.active.get(p.partnerId) ?? 0)) })),
    });
  }),

  route(117, 'POST /partners', ['orders', 'edit'], async (req, res) => {
    const b = req.body as { name: string; type: (typeof PARTNER_TYPES)[number]; base: string; capacity?: string; email: string; phone?: string; accreditation?: string; draft: boolean };
    const actor = auditActor(req);
    const partner = await withTx(async (session) => {
      const partnerId = await nextId('partner', session);
      const [created] = await Partner.create([{ partnerId, name: b.name, type: b.type, base: b.base, capacity: b.capacity, email: b.email, phone: b.phone, accreditation: b.accreditation, status: 'onboarding', createdBy: actor.staffId }], { session });
      await recordAudit({ actor, category: 'orders', action: 'Added partner', record: { type: 'partner', id: partnerId, label: b.name }, after: { type: b.type, status: 'onboarding' }, req, session });
      return created!.toObject();
    });
    res.status(201).json({ ...partnerDto(partner, 0, 0), message: 'Partner added in Onboarding status' });
  }, {
    body: z.object({ name: z.string().trim().min(2).max(160), type: z.enum(PARTNER_TYPES), base: z.string().trim().min(1).max(120), capacity: z.string().trim().max(160).optional(), email: z.string().trim().email(), phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'Invalid phone').optional(), accreditation: z.string().trim().max(160).optional(), draft: z.boolean().default(false) }),
  }),

  route(118, 'PATCH /partners/:partnerId', ['orders', 'edit'], async (req, res) => {
    const partnerId = String(req.params.partnerId);
    const b = req.body as { status?: (typeof PARTNER_STATUSES)[number]; email?: string; phone?: string; base?: string; capacity?: string; internalNote?: string };
    const before = await Partner.findOne({ partnerId }).lean();
    if (!before) throw notFound('resource/not-found', `Partner ${partnerId} not found`);
    const actor = auditActor(req);
    const { updated, auditId } = await withTx(async (session) => {
      const updated = await Partner.findOneAndUpdate({ partnerId, __v: before.__v }, { $set: b, $inc: { __v: 1 } }, { new: true, session }).lean();
      if (!updated) throw conflict('conflict/stale-state', `${partnerId} was changed by someone else — reload and retry.`);
      const auditId = await recordAudit({ actor, category: 'orders', action: b.status && b.status !== before.status ? `Set partner ${b.status.replace('_', ' ')}` : 'Updated partner', record: { type: 'partner', id: partnerId, label: updated.name }, before: Object.fromEntries(Object.keys(b).map((k) => [k, (before as Record<string, unknown>)[k]])), after: b, req, session });
      return { updated, auditId };
    });
    const u = await usage([updated]);
    const activeOrders = u.active.get(partnerId) ?? 0;
    const suspended = b.status === 'suspended' && before.status !== 'suspended';
    const body = action(partnerDto(updated, u.total.get(partnerId) ?? 0, activeOrders), suspended ? `${updated.name} suspended — removed from new order assignments${activeOrders ? ` (${activeOrders} active orders keep it)` : ''}` : `${updated.name} updated`, auditId);
    res.json(suspended ? { ...body, details: { activeOrders } } : body);
  }, {
    body: z.object({ status: z.enum(PARTNER_STATUSES), email: z.string().trim().email(), phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'Invalid phone'), base: z.string().trim().min(1).max(120), capacity: z.string().trim().max(160), internalNote: z.string().trim().max(2000) }).partial().refine((o) => Object.keys(o).length > 0, 'Nothing to update'),
  }),
];
