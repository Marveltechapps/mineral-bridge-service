import type { ClientSession } from 'mongoose';
import { z } from 'zod';
import { AppError, notFound, unprocessable } from '../../../common/errors/app-error.js';
import { withTx } from '../../../common/db/transaction.js';
import { assertIfMatch, setEtag } from '../../../common/http/etag.js';
import { MODULES } from '../../../models/shared.js';
import { SettingsDoc } from '../../../models/platform.models.js';
import { Role } from '../../auth/auth.models.js';
import { StaffModel } from '../../staff/staff.model.js';
import { auditActor } from '../shared/staff-context.js';
import { recordAudit } from '../../audit/audit.service.js';
import { Country } from '../../reference/reference.model.js';
import { outMoney } from '../shared/money.js';
import { route, type AdminRouteDef } from '../shared/route-kit.js';
import {
  PLATFORM_SETTING_DEFS,
  ensureSettings,
  getPlatformValues,
  settingsEtag,
  validatePlatformValues,
} from './settings.service.js';

async function rolesBody() {
  const [roles, seats, doc] = await Promise.all([
    Role.find().sort({ roleId: 1 }).lean(),
    StaffModel.aggregate([{ $match: { disabled: false } }, { $group: { _id: '$role.id', n: { $sum: 1 } } }]),
    ensureSettings('roles'),
  ]);
  const seatMap = new Map(seats.map((s) => [s._id as string, s.n as number]));
  return {
    modules: [...MODULES],
    roles: roles.map((r) => ({
      id: r.roleId,
      name: r.name,
      description: r.description ?? '',
      seats: seatMap.get(r.roleId) ?? 0,
      access: Object.fromEntries(MODULES.map((m) => [m, r.access?.[m] ?? 'none'])),
    })),
    etag: settingsEtag('r', doc.version),
  };
}

async function platformBody() {
  const [values, doc] = await Promise.all([getPlatformValues(), ensureSettings('platform')]);
  return {
    settings: PLATFORM_SETTING_DEFS.map((d) => ({ key: d.key, label: d.label, description: d.description, value: values[d.key], unit: d.unit, min: d.min, max: d.max })),
    etag: settingsEtag('p', doc.version),
  };
}

async function btcBody() {
  const [countries, doc] = await Promise.all([Country.find({ 'btc.regulation': { $exists: true } }).sort({ name: 1 }).lean(), ensureSettings('btc')]);
  return {
    data: countries.map((c) => ({
      code: c.code,
      name: c.name,
      regulation: c.btc?.regulation,
      regulationLabel: c.btc?.regulationLabel,
      rail: c.btc?.rail,
      limit: outMoney(c.btc?.limit),
      enabled: Boolean(c.btc?.enabled),
      locked: c.btc?.regulation === 'prohibited',
    })),
    meta: { enabledCount: countries.filter((c) => c.btc?.enabled).length },
    etag: settingsEtag('b', doc.version),
  };
}

/** Bumps the settings doc version only if it still equals `expected` (optimistic lock). */
async function bumpVersion(key: 'roles' | 'platform' | 'btc', expected: number, by: string, values?: Record<string, unknown>, session?: ClientSession) {
  const set: Record<string, unknown> = { updatedBy: by };
  if (values) for (const [k, v] of Object.entries(values)) set[`values.${k}`] = v;
  const updated = await SettingsDoc.findOneAndUpdate({ key, version: expected }, { $set: set, $inc: { version: 1 } }, { new: true, session });
  if (!updated) {
    throw new AppError({ status: 412, code: 'conflict/etag-mismatch', message: 'Someone else changed this — reload and try again.' });
  }
  return updated;
}
export const settingsRoutes: AdminRouteDef[] = [
  route(129, 'GET /settings/roles', ['settings', 'view'], async (_req, res) => {
    const body = await rolesBody();
    setEtag(res, body.etag);
    res.json(body);
  }),

  route(130, 'PUT /settings/roles/permissions', ['settings', 'edit'], async (req, res) => {
    const { changes, reason } = req.body as { changes: Array<{ roleId: string; module: (typeof MODULES)[number]; access: 'none' | 'view' | 'edit' }>; reason?: string };
    const current = await ensureSettings('roles');
    assertIfMatch(req, settingsEtag('r', current.version));
    const actor = auditActor(req);

    const roles = await Role.find().lean();
    const byId = new Map(roles.map((r) => [r.roleId as string, r]));
    const effective = new Map<string, Record<string, string>>(roles.map((r) => [r.roleId, { ...(r.access ?? {}) }]));
    const real: Array<{ roleId: string; module: string; before: string; after: string }> = [];
    for (const c of changes) {
      const role = byId.get(c.roleId);
      if (!role) throw notFound('resource/not-found', `Role ${c.roleId} not found`);
      const before = effective.get(c.roleId)![c.module] ?? 'none';
      if (before !== c.access) {
        real.push({ roleId: c.roleId, module: c.module, before, after: c.access });
        effective.get(c.roleId)![c.module] = c.access;
      }
    }
    // Lockout rule: somebody active must always keep settings:edit.
    const seatRows = await StaffModel.aggregate([{ $match: { disabled: false } }, { $group: { _id: '$role.id', n: { $sum: 1 } } }]);
    const holders = seatRows.filter((s) => effective.get(s._id)?.settings === 'edit').reduce((n, s) => n + s.n, 0);
    if (holders === 0) {
      throw new AppError({ status: 422, code: 'rule/lockout', message: 'This change would remove settings:edit from every active staff member.' });
    }

    await withTx(async (session) => {
      await bumpVersion('roles', current.version, actor.staffId, undefined, session);
      for (const c of real) {
        await Role.updateOne({ roleId: c.roleId }, { $set: { [`access.${c.module}`]: c.after } }, { session });
        // Staff rows embed their permissions (modules/staff) — keep them in step with the role.
        await StaffModel.updateMany({ 'role.id': c.roleId }, { $set: { [`permissions.${c.module}`]: c.after } }, { session });
        await recordAudit({
          actor,
          category: 'roles_access',
          action: `Changed ${c.module} access`,
          record: { type: 'role', id: c.roleId, label: byId.get(c.roleId)!.name },
          before: { [c.module]: c.before },
          after: { [c.module]: c.after },
          reason,
          req,
          session,
        });
      }
    });
    const body = await rolesBody();
    setEtag(res, body.etag);
    res.json({ ...body, message: 'Role permissions saved — change written to the audit log', changed: real.length });
  }, {
    body: z.object({
      changes: z.array(z.object({ roleId: z.string().min(1), module: z.enum(MODULES), access: z.enum(['none', 'view', 'edit']) })).min(1),
      reason: z.string().max(500).optional(),
    }),
  }),

  route(131, 'GET /settings/platform', ['settings', 'view'], async (_req, res) => {
    const body = await platformBody();
    setEtag(res, body.etag);
    res.json(body);
  }),

  route(132, 'PUT /settings/platform', ['settings', 'edit'], async (req, res) => {
    const current = await ensureSettings('platform');
    assertIfMatch(req, settingsEtag('p', current.version));
    const values = validatePlatformValues(req.body.values);
    const before = await getPlatformValues();
    const actor = auditActor(req);
    await withTx(async (session) => {
      await bumpVersion('platform', current.version, actor.staffId, values, session);
      for (const [k, v] of Object.entries(values)) {
        if (before[k] === v) continue;
        await recordAudit({
          actor,
          category: 'roles_access',
          action: `Changed platform setting ${k}`,
          record: { type: 'role', id: `setting:${k}`, label: PLATFORM_SETTING_DEFS.find((d) => d.key === k)?.label ?? k },
          before: { [k]: before[k] },
          after: { [k]: v },
          req,
          session,
        });
      }
    });
    const body = await platformBody();
    setEtag(res, body.etag);
    res.json(body);
  }, { body: z.object({ values: z.record(z.unknown()).refine((v) => Object.keys(v).length > 0, 'No values supplied') }) }),

  route(133, 'GET /settings/btc/countries', ['settings', 'view'], async (_req, res) => {
    const body = await btcBody();
    setEtag(res, body.etag);
    res.json(body);
  }),

  route(134, 'PUT /settings/btc/countries', ['settings', 'edit'], async (req, res) => {
    const { changes, reason } = req.body as { changes: Array<{ code: string; enabled: boolean }>; reason?: string };
    const current = await ensureSettings('btc');
    assertIfMatch(req, settingsEtag('b', current.version));
    const actor = auditActor(req);
    const countries = await Country.find({ code: { $in: changes.map((c) => c.code) } }).lean();
    const byCode = new Map(countries.map((c) => [c.code as string, c]));
    for (const c of changes) {
      const country = byCode.get(c.code);
      if (!country) throw unprocessable('Unknown country', { code: `Unknown country ${c.code}` });
      if (c.enabled && country.btc?.regulation === 'prohibited') {
        throw new AppError({ status: 422, code: 'rule/country-prohibited', message: `Bitcoin payments are prohibited in ${country.name}` });
      }
    }
    await withTx(async (session) => {
      await bumpVersion('btc', current.version, actor.staffId, undefined, session);
      for (const c of changes) {
        const country = byCode.get(c.code)!;
        if (Boolean(country.btc?.enabled) === c.enabled) continue;
        await Country.updateOne({ code: c.code }, { $set: { 'btc.enabled': c.enabled } }, { session });
        await recordAudit({
          actor,
          category: 'roles_access',
          action: `${c.enabled ? 'Enabled' : 'Disabled'} Bitcoin settlement`,
          record: { type: 'role', id: `btc:${c.code}`, label: country.name },
          before: { enabled: Boolean(country.btc?.enabled) },
          after: { enabled: c.enabled },
          reason,
          req,
          session,
        });
      }
    });
    const body = await btcBody();
    setEtag(res, body.etag);
    res.json(body);
  }, {
    body: z.object({
      changes: z.array(z.object({ code: z.string().length(2).toUpperCase(), enabled: z.boolean() })).min(1),
      reason: z.string().max(500).optional(),
    }),
  }),
];
