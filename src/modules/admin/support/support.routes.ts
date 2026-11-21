import { z } from 'zod';
import { notFound, unprocessable } from '../../../common/errors/app-error.js';
import { nextId } from '../../../common/db/sequence.js';
import { withTx } from '../../../common/db/transaction.js';
import { Call, Ticket } from '../../../models/content.models.js';
import { Order } from '../../../models/trading.models.js';
import { recordAudit } from '../../audit/audit.service.js';
import { StaffModel } from '../../staff/staff.model.js';
import { TICKET_STATUSES } from '../shared/enums.js';
import { and, escapeRegex, iso, oneOf, pageOf, paging, sortSpec } from '../shared/http.js';
import { loadStaffMap, loadUserMap, partyFrom, requireUser, staffFrom, unknownParty } from '../shared/refs.js';
import { route, type AdminRouteDef } from '../shared/route-kit.js';
import { auditActor } from '../shared/staff-context.js';
import { ticketDto, userIdsMatching } from '../people/people.dto.js';

async function staffIdsMatching(q: unknown): Promise<string[]> {
  if (typeof q !== 'string' || !q.trim()) return [];
  const rows = await StaffModel.find({ name: new RegExp(escapeRegex(q.trim()), 'i') }).select('publicId').limit(50).lean();
  return rows.map((r: { publicId: string }) => r.publicId);
}

async function mapTickets(docs: Array<Record<string, any>>) {  
  const [users, staff] = await Promise.all([loadUserMap(docs.map((d) => d.userId)), loadStaffMap(docs.map((d) => d.ownerId))]);
  return docs.map((d) => ticketDto(d, users, staff));
}

export const supportRoutes: AdminRouteDef[] = [
  route(119, 'GET /support/tickets', ['support', 'view'], async (req, res) => {
    const status = oneOf(req.query.status, TICKET_STATUSES, 'status');
    const ownerId = typeof req.query.ownerId === 'string' && req.query.ownerId ? req.query.ownerId : undefined;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const re = q ? new RegExp(escapeRegex(q), 'i') : null;
    let search: Record<string, unknown> | null = null;
    if (re) {
      const [uids, sids] = await Promise.all([userIdsMatching(q), staffIdsMatching(q)]);
      search = { $or: [{ ticketId: re }, { subject: re }, { 'linked.id': re }, { status: re }, { ownerTeam: re }, { userId: { $in: uids } }, { ownerId: { $in: sids } }] };
    }
    const sort = sortSpec(req, { id: 'ticketId', status: 'status', owner: 'ownerId', age: 'openedAt' }, { openedAt: 1, _id: 1 });
    if (req.query.sort === 'age') sort.openedAt = (sort.openedAt === 1 ? -1 : 1) as 1 | -1; // older = greater age
    res.json(await pageOf(Ticket, { filter: and({ isDraft: { $ne: true } }, status && { status }, ownerId && { ownerId }, search), sort, paging: paging(req), map: mapTickets }));
  }),

  route(120, 'POST /support/tickets', ['support', 'edit'], async (req, res) => {
    const b = req.body as { userId: string; linked?: { type: string; id: string } | null; subject: string; ownerId: string; firstNote?: string; channel: 'phone' | 'whatsapp' | 'email'; draft: boolean };
    const user = await requireUser(b.userId);
    const staff = await loadStaffMap([b.ownerId]);
    if (!staff.has(b.ownerId)) throw unprocessable('Unknown owner', { ownerId: 'Unknown staff member' });
    if (b.linked?.type === 'order' && !(await Order.exists({ orderId: b.linked.id }))) throw unprocessable('Unknown linked order', { linked: `Order ${b.linked.id} not found` });
    const actor = auditActor(req);
    const now = new Date();
    const created = await withTx(async (session) => {
      const ticketId = await nextId('ticket', session);
      const notes = b.firstNote ? [{ id: await nextId('ticketNote', session), authorId: actor.staffId, text: b.firstNote, at: now }] : [];
      const [t] = await Ticket.create([{ ticketId, subject: b.subject, userId: user.userId, linked: b.linked ?? undefined, status: 'open', ownerId: b.ownerId, channel: b.channel, openedAt: now, isDraft: b.draft, notes, createdBy: actor.staffId }], { session });
      await recordAudit({ actor, category: 'orders', action: b.draft ? 'Saved ticket draft' : 'Opened support ticket', record: { type: 'ticket', id: ticketId, label: b.subject }, after: { userId: user.userId, ownerId: b.ownerId, channel: b.channel, linked: b.linked ?? null }, req, session });
      return t!.toObject();
    });
    const [dto] = await mapTickets([created]);
    res.status(201).json({ ...dto, message: b.draft ? 'Ticket saved as a draft' : 'Ticket opened and assigned' });
  }, {
    body: z.object({
      userId: z.string().min(1),
      linked: z.object({ type: z.string().min(1).max(40), id: z.string().min(1).max(80) }).nullable().optional(),
      subject: z.string().trim().min(3).max(200),
      ownerId: z.string().min(1),
      firstNote: z.string().trim().max(4000).optional(),
      channel: z.enum(['phone', 'whatsapp', 'email']).default('phone'),
      draft: z.boolean().default(false),
    }),
  }),

  route(121, 'GET /support/tickets/:ticketId', ['support', 'view'], async (req, res) => {
    const t = await Ticket.findOne({ ticketId: String(req.params.ticketId) }).lean();
    if (!t) throw notFound('resource/not-found', `Ticket ${req.params.ticketId} not found`);
    const [dto] = await mapTickets([t]);
    const staff = await loadStaffMap((t.notes ?? []).map((n: { authorId?: string }) => n.authorId));
    res.json({ ...dto, notes: (t.notes ?? []).map((n: Record<string, any>) => ({ id: n.id, author: staffFrom(staff, n.authorId), text: n.text, at: iso(n.at) })) });  
  }),

  route(122, 'GET /support/calls', ['support', 'view'], async (req, res) => {
    const direction = oneOf(req.query.direction, ['inbound', 'outbound'] as const, 'direction');
    const agentId = typeof req.query.agentId === 'string' && req.query.agentId ? req.query.agentId : undefined;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const re = q ? new RegExp(escapeRegex(q), 'i') : null;
    let search: Record<string, unknown> | null = null;
    if (re) {
      const [uids, sids] = await Promise.all([userIdsMatching(q), staffIdsMatching(q)]);
      search = { $or: [{ phone: re }, { topic: re }, { userId: { $in: uids } }, { agentId: { $in: sids } }] };
    }
    res.json(
      await pageOf(Call, {
        filter: and(direction && { direction }, agentId && { agentId }, search),
        sort: sortSpec(req, { at: 'at', who: 'userId', duration: 'durationSec', agent: 'agentId' }, { at: -1, _id: 1 }),
        paging: paging(req),
        map: async (docs: any[]) => {  
          const [users, staff] = await Promise.all([loadUserMap(docs.map((d) => d.userId)), loadStaffMap(docs.map((d) => d.agentId))]);
          return docs.map((d) => ({ id: d.callId, at: iso(d.at), who: (d.userId ? partyFrom(users, d.userId) : null) ?? unknownParty(d.phone ?? 'unknown'), phone: d.phone ?? '', direction: d.direction, durationSec: d.durationSec ?? 0, topic: d.topic ?? '', agent: staffFrom(staff, d.agentId) }));
        },
      }),
    );
  }),
];
