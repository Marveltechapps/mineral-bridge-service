import { z } from 'zod';
import { AppError, notFound } from '../../../common/errors/app-error.js';
import { buildMe } from '../../auth/admin.auth.service.js';
import { getStaffContext } from '../../auth/auth.middleware.js';
import { recordAudit } from '../../audit/audit.service.js';
import { deriveCsrfToken, findStaffSessionByPublicId, listActiveStaffSessions, revokeAllStaffSessions, revokeStaffSession } from '../../sessions/session.service.js';
import { findStaffById, notificationPreferenceList, setNotificationPreferences, updateStaffProfile } from '../../staff/staff.service.js';
import { maskPhone } from '../../../common/notify/sms.js';
import { iso } from '../shared/http.js';
import { route, type AdminRouteDef } from '../shared/route-kit.js';
import { auditActor, staffActor } from '../shared/staff-context.js';

function maskIp(ip?: string | null): string {
  if (!ip) return '—';
  const v4 = ip.replace('::ffff:', '').split('.');
  if (v4.length === 4) return `${v4[0]}.${v4[1]}.x.x`;
  return `${ip.split(':').slice(0, 2).join(':')}:…`;
}

export const profileRoutes: AdminRouteDef[] = [
  // #135 — name / phone / desk. A changed phone is the 2FA delivery channel, so every *other* session is signed out.
  route(135, 'PATCH /me', 'auth', async (req, res) => {
    const a = staffActor(req);
    const ctx = getStaffContext(req);
    const body = req.body as { name?: string; phone?: string; desk?: string };
    const before = ctx.staff;
    const changed: Record<string, unknown> = {};
    if (body.name !== undefined && body.name !== before.name) changed.name = body.name;
    if (body.desk !== undefined && body.desk !== before.desk) changed.desk = body.desk;
    const phoneChanged = body.phone !== undefined && body.phone !== before.phone;
    if (phoneChanged) changed.phone = body.phone;
    let staff = before;
    if (Object.keys(changed).length) {
      staff = await updateStaffProfile(before.id, { name: body.name, phone: body.phone, desk: body.desk });
      if (phoneChanged) await revokeAllStaffSessions(before.id, { exceptId: ctx.session.id, reason: 'phone_changed' });
      await recordAudit({
        actor: auditActor(req),
        category: 'auth',
        action: phoneChanged ? 'Updated own profile (2FA phone changed)' : 'Updated own profile',
        record: { type: 'staff', id: a.staffId, label: before.name },
        before: { name: before.name, desk: before.desk, phone: before.phone ? maskPhone(before.phone) : undefined },
        after: { ...changed, ...(phoneChanged ? { phone: maskPhone(String(body.phone)) } : {}) },
        req,
      });
    }
    res.json(buildMe(staff, ctx.session, deriveCsrfToken(ctx.sessionToken)));
  }, {
    body: z.object({
      name: z.string().trim().min(2).max(120).optional(),
      phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid phone number').optional(),
      desk: z.string().trim().max(120).optional(),
    }).strict(),
  }),

  route(136, 'GET /me/sessions', 'auth', async (req, res) => {
    const ctx = getStaffContext(req);
    const sessions = await listActiveStaffSessions(ctx.staff.id);
    res.json({
      data: sessions.map((s) => ({
        id: s.publicId,
        device: s.device?.name ?? s.device?.userAgent ?? 'Unknown device',
        location: s.device?.location ?? '—',
        ipMasked: maskIp(s.device?.ip),
        lastActiveAt: iso(s.lastUsedAt),
        current: s.publicId === ctx.session.publicId,
      })),
    });
  }),

  route(137, 'DELETE /me/sessions/:sessionId', 'auth', async (req, res) => {
    const a = staffActor(req);
    const ctx = getStaffContext(req);
    const sessionId = String(req.params.sessionId);
    if (sessionId === a.sessionId) {
      throw new AppError({ status: 422, code: 'rule/cannot-revoke-current', message: 'Use sign out to end your current session.' });
    }
    const s = await findStaffSessionByPublicId(sessionId);
    if (!s || s.staffId.toString() !== ctx.staff.id || s.revokedAt) throw notFound('resource/not-found', 'Session not found');
    await revokeStaffSession(s.id, 'revoked_by_user');
    await recordAudit({
      actor: auditActor(req),
      category: 'auth',
      action: 'Revoked session',
      record: { type: 'staff', id: a.staffId, label: a.name },
      before: { sessionId, device: s.device?.name },
      after: { revoked: true },
      req,
    });
    res.status(204).end();
  }),

  route(138, 'GET /me/notification-preferences', 'auth', async (req, res) => {
    const staff = await findStaffById(getStaffContext(req).staff.id);
    res.json({ preferences: notificationPreferenceList((staff?.notificationPreferences ?? {}) as Record<string, boolean>) });
  }),

  route(139, 'PUT /me/notification-preferences', 'auth', async (req, res) => {
    const a = staffActor(req);
    const ctx = getStaffContext(req);
    const incoming = req.body.preferences as Record<string, boolean>;
    const before = notificationPreferenceList((ctx.staff.notificationPreferences ?? {}) as Record<string, boolean>);
    const updated = await setNotificationPreferences(ctx.staff.id, incoming);
    await recordAudit({
      actor: auditActor(req),
      category: 'auth',
      action: 'Updated notification preferences',
      record: { type: 'staff', id: a.staffId, label: a.name },
      before: Object.fromEntries(before.filter((p) => p.key in incoming).map((p) => [p.key, p.enabled])),
      after: incoming,
      req,
    });
    res.json({ preferences: notificationPreferenceList((updated.notificationPreferences ?? {}) as Record<string, boolean>) });
  }, { body: z.object({ preferences: z.record(z.boolean()) }) }),
];
