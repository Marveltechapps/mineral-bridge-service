/**
 * Admin accounts and roles for the console (Settings -> Admin users, Roles & permissions).
 *
 * Roles
 *  - The nine built-in roles come from code. An edit to a built-in role (its name or its action
 *    list) is stored as an override row, so "Reset to default" is a delete.
 *  - Custom roles are rows in the `console_roles` settings document.
 *  - A role's action list is copied onto each staff member (`actions`, `actionsOverride`) so the
 *    per-request permission check stays a single read. Editing a role rewrites those copies.
 *
 * Admins
 *  - Nothing is destroyed. "Delete" disables the account, stamps `deletedAt`, and frees the email
 *    address; the row and every audit entry that names it remain.
 *  - You cannot disable or delete yourself, nor the last active Super admin.
 */
import { randomBytes } from 'node:crypto';
import { conflict, notFound, unprocessable } from '../../../common/errors/app-error.js';
import { SettingsDoc } from '../../../models/platform.models.js';
import { recordAudit } from '../../audit/audit.service.js';
import { STAFF_ACTIONS, actionsForRoleKey } from '../../staff/actions.js';
import { getDefaultRole, noPermissions, permissionsForRole } from '../../staff/default-roles.js';
import { StaffModel } from '../../staff/staff.model.js';
import type { StaffShape } from '../../staff/staff.types.js';

export type AccessStaff = { id: string; name: string; publicId?: string };

export const BUILTIN_ROLES: ReadonlyArray<readonly [key: string, label: string]> = [
  ['super', 'Super admin'],
  ['ops', 'Operations manager'],
  ['trading', 'Trading desk'],
  ['compliance', 'Compliance'],
  ['inspection', 'Inspection coordinator'],
  ['finance', 'Finance'],
  ['logistics', 'Logistics coordinator'],
  ['catalogue', 'Catalogue manager'],
  ['support', 'Support agent'],
];

/** Built-in console roles that start from one of the platform's default permission matrices. */
export const ROLE_ID_BY_KEY: Record<string, string> = {
  super: 'ROLE-CEO',
  ops: 'ROLE-DESK',
  compliance: 'ROLE-COMPLIANCE',
  support: 'ROLE-SUPPORT',
  catalogue: 'ROLE-CONTENT',
};
const KEY_BY_ROLE_ID: Record<string, string> = Object.fromEntries(Object.entries(ROLE_ID_BY_KEY).map(([k, v]) => [v, k]));

const ROLES_DOC = 'console_roles';
const ACTION_SET = new Set<string>(STAFF_ACTIONS);

type RoleRow = {
  key: string;
  label: string;
  actions: string[];
  custom: boolean;
  createdAt: number;
  updatedAt: number;
  updatedBy?: string;
};

export interface ConsoleRole {
  key: string;
  label: string;
  actions: string[];
  builtin: boolean;
  custom: boolean;
  /** A built-in role whose name or permissions were changed from the default. */
  customised: boolean;
  defaultActions: string[];
  people: number;
  updatedAt: number | null;
}

/** The key the console uses for a staff member: stored `roleKey`, else derived from the default role id. */
export function consoleRoleKey(s: { roleKey?: string; role?: { id?: string; name?: string } }): string {
  if (s.roleKey) return s.roleKey;
  const id = s.role?.id ?? '';
  return KEY_BY_ROLE_ID[id] ?? (id || '');
}

export function adminRow(s: Pick<StaffShape, 'publicId' | 'name' | 'email' | 'mfa' | 'disabled' | 'roleKey' | 'role'>) {
  return {
    id: s.publicId,
    role: consoleRoleKey(s),
    name: s.name,
    email: s.email,
    tfa: s.mfa?.enabled !== false,
    status: s.disabled ? 'disabled' : 'active',
    live: true,
  };
}

// ---------------------------------------------------------------------------------------------
// Role store
// ---------------------------------------------------------------------------------------------

async function readRows(): Promise<{ rows: RoleRow[]; version: number }> {
  const doc = await SettingsDoc.findOne({ key: ROLES_DOC }).lean<{ values?: { rows?: RoleRow[] }; version?: number }>();
  const rows = doc?.values?.rows;
  return { rows: Array.isArray(rows) ? rows : [], version: doc ? doc.version ?? 1 : 0 };
}

async function writeRows(rows: RoleRow[], version: number, by: string) {
  if (version === 0) {
    try {
      await SettingsDoc.create({ key: ROLES_DOC, values: { rows }, version: 1, updatedBy: by });
      return;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw conflict('role/changed', 'Roles changed while you were editing. Refresh and try again.');
      throw err;
    }
  }
  const res = await SettingsDoc.updateOne({ key: ROLES_DOC, version }, { $set: { values: { rows }, updatedBy: by }, $inc: { version: 1 } });
  if (res.matchedCount !== 1) throw conflict('role/changed', 'Roles changed while you were editing. Refresh and try again.');
}

function cleanActions(raw: readonly string[] | undefined, field = 'actions'): string[] {
  const list = [...new Set(raw ?? [])];
  const bad = list.filter((a) => !ACTION_SET.has(a));
  if (bad.length) throw unprocessable('Unknown permission.', { [field]: `Unknown: ${bad.join(', ')}` });
  return STAFF_ACTIONS.filter((a) => list.includes(a));
}

function cleanLabel(raw: string): string {
  const label = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (label.length < 2) throw unprocessable('Name the role.', { label: 'Required' });
  if (label.length > 60) throw unprocessable('Use at most 60 characters.', { label: 'Too long' });
  return label;
}

function mergeRoles(rows: RoleRow[]): Omit<ConsoleRole, 'people'>[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const builtin = BUILTIN_ROLES.map(([key, label]) => {
    const o = byKey.get(key);
    const defaults = actionsForRoleKey(key);
    return {
      key,
      label: o?.label ?? label,
      actions: key === 'super' ? [...STAFF_ACTIONS] : o ? o.actions : defaults,
      builtin: true,
      custom: false,
      customised: Boolean(o) && key !== 'super',
      defaultActions: defaults,
      updatedAt: o?.updatedAt ?? null,
    };
  });
  const custom = rows
    .filter((r) => r.custom)
    .map((r) => ({
      key: r.key,
      label: r.label,
      actions: r.actions,
      builtin: false,
      custom: true,
      customised: false,
      defaultActions: [] as string[],
      updatedAt: r.updatedAt,
    }));
  return [...builtin, ...custom];
}

async function peopleByRole(): Promise<Map<string, number>> {
  const staff = await StaffModel.find({ deletedAt: { $exists: false } }).select('roleKey role').lean<Pick<StaffShape, 'roleKey' | 'role'>[]>();
  const counts = new Map<string, number>();
  for (const s of staff) {
    const key = consoleRoleKey(s);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export async function listRoles(): Promise<ConsoleRole[]> {
  const [{ rows }, people] = await Promise.all([readRows(), peopleByRole()]);
  return mergeRoles(rows).map((r) => ({ ...r, people: people.get(r.key) ?? 0 }));
}

/** One role as it applies right now, or a 422 when the key is unknown. */
export async function resolveRole(key: string): Promise<Omit<ConsoleRole, 'people'>> {
  const { rows } = await readRows();
  const role = mergeRoles(rows).find((r) => r.key === key);
  if (!role) throw unprocessable('Unknown role.', { roleKey: 'Unknown role' });
  return role;
}

/** Console-shaped views of the role store: `customRoles` pairs, `roleLabels` renames and `perms` per role. */
export async function consoleRoleSnapshot() {
  const roles = await listRoles();
  return {
    roles,
    customRoles: roles.filter((r) => r.custom).map((r) => [r.key, r.label] as [string, string]),
    roleLabels: Object.fromEntries(roles.filter((r) => r.builtin && r.customised).map((r) => [r.key, r.label])),
    perms: Object.fromEntries(roles.filter((r) => r.key !== 'super').map((r) => [r.key, r.actions])),
  };
}

function roleMatch(key: string): Record<string, unknown> {
  const id = ROLE_ID_BY_KEY[key];
  return id
    ? { $or: [{ roleKey: key }, { 'role.id': id, roleKey: { $exists: false } }], deletedAt: { $exists: false } }
    : { roleKey: key, deletedAt: { $exists: false } };
}

async function audit(
  staff: AccessStaff,
  action: string,
  record: { type: string; id: string; label?: string },
  extra?: { before?: unknown; after?: unknown; reason?: string },
) {
  await recordAudit({
    actor: { staffId: staff.publicId || staff.id, name: staff.name },
    category: 'roles_access',
    action,
    record,
    ...extra,
  });
}

export async function createRole(input: { label: string; copyFrom?: string; actions?: string[] }, staff: AccessStaff) {
  const label = cleanLabel(input.label);
  const { rows, version } = await readRows();
  const all = mergeRoles(rows);
  if (all.some((r) => r.label.toLowerCase() === label.toLowerCase())) throw conflict('role/duplicate', 'A role with that name exists.');
  let actions: string[] = [];
  if (input.actions) actions = cleanActions(input.actions);
  else if (input.copyFrom) {
    const source = all.find((r) => r.key === input.copyFrom);
    if (!source) throw unprocessable('Unknown role to copy.', { copyFrom: 'Unknown role' });
    actions = source.actions.filter((a) => ACTION_SET.has(a));
  }
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  const key = `r_${slug}_${randomBytes(2).toString('hex')}`;
  const now = Date.now();
  await writeRows([...rows, { key, label, actions, custom: true, createdAt: now, updatedAt: now, updatedBy: staff.id }], version, staff.id);
  await audit(staff, 'Role created', { type: 'Role', id: key, label }, { after: { actions, copyFrom: input.copyFrom ?? null } });
  return { key, label, actions, custom: true, builtin: false, people: 0 };
}

export async function updateRole(
  key: string,
  patch: { label?: string; actions?: string[]; reset?: boolean },
  staff: AccessStaff,
) {
  if (key === 'super') throw conflict('role/super-locked', 'Super admin always has every permission and cannot be changed.');
  const { rows, version } = await readRows();
  const all = mergeRoles(rows);
  const current = all.find((r) => r.key === key);
  if (!current) throw notFound('role/not-found', 'Role not found');
  const stored = rows.find((r) => r.key === key);

  let label = current.label;
  let actions = current.actions;
  if (patch.reset) {
    if (current.custom) throw unprocessable('A custom role has no default to return to.', { reset: 'Not applicable' });
    label = BUILTIN_ROLES.find(([k]) => k === key)![1];
    actions = actionsForRoleKey(key);
  } else {
    if (patch.label !== undefined) {
      label = cleanLabel(patch.label);
      if (all.some((r) => r.key !== key && r.label.toLowerCase() === label.toLowerCase())) throw conflict('role/duplicate', 'A role with that name exists.');
    }
    if (patch.actions !== undefined) actions = cleanActions(patch.actions);
  }
  const actionsChanged = JSON.stringify(actions) !== JSON.stringify(current.actions) || Boolean(patch.reset);
  const labelChanged = label !== current.label;
  if (!actionsChanged && !labelChanged) return { key, label, actions, builtin: current.builtin, custom: current.custom };

  const now = Date.now();
  let next: RoleRow[];
  if (patch.reset) next = rows.filter((r) => r.key !== key);
  else if (stored) next = rows.map((r) => (r.key === key ? { ...r, label, actions, updatedAt: now, updatedBy: staff.id } : r));
  else next = [...rows, { key, label, actions, custom: false, createdAt: now, updatedAt: now, updatedBy: staff.id }];
  await writeRows(next, version, staff.id);

  const $set: Record<string, unknown> = {};
  if (actionsChanged) {
    $set.actions = actions;
    $set.actionsOverride = !patch.reset;
  }
  if (labelChanged) $set['role.name'] = label;
  await StaffModel.updateMany({ ...roleMatch(key), 'role.id': { $ne: 'ROLE-CEO' } }, { $set });

  await audit(
    staff,
    patch.reset ? 'Permissions reset to default' : labelChanged && !actionsChanged ? 'Role renamed' : 'Role permissions changed',
    { type: 'Role', id: key, label },
    { before: { label: current.label, actions: current.actions }, after: { label, actions } },
  );
  return { key, label, actions, builtin: current.builtin, custom: current.custom };
}

export async function deleteRole(key: string, staff: AccessStaff, reason?: string) {
  if (BUILTIN_ROLES.some(([k]) => k === key)) {
    throw conflict('role/builtin', 'Built-in roles are used by the order steps and cannot be deleted. Rename it or change its permissions instead.');
  }
  const { rows, version } = await readRows();
  const role = rows.find((r) => r.key === key && r.custom);
  if (!role) throw notFound('role/not-found', 'Role not found');
  const people = await StaffModel.countDocuments(roleMatch(key));
  if (people) throw conflict('role/in-use', 'Move the admins with this role to another role first.', { details: { people } });
  await writeRows(rows.filter((r) => r.key !== key), version, staff.id);
  await audit(staff, 'Role deleted', { type: 'Role', id: key, label: role.label }, { before: { label: role.label, actions: role.actions }, reason });
  return { ok: true as const, key };
}

// ---------------------------------------------------------------------------------------------
// Admin accounts
// ---------------------------------------------------------------------------------------------

/** Everything a staff row needs so the permission check reflects `roleKey`. */
export async function roleAssignment(roleKeyRaw: string) {
  const roleKey = roleKeyRaw.trim();
  const role = await resolveRole(roleKey);
  const roleId = ROLE_ID_BY_KEY[roleKey];
  const def = roleId ? getDefaultRole(roleId) : undefined;
  return {
    roleKey,
    role: { id: roleId ?? roleKey, name: roleKey === 'super' && def ? def.name : role.label, scope: def?.scope ?? 'console' },
    permissions: roleId && def ? permissionsForRole(roleId) : noPermissions(),
    actions: role.actions,
    actionsOverride: roleKey === 'super' ? false : role.custom || role.customised,
  };
}

async function loadAdmin(publicId: string) {
  const staff = await StaffModel.findOne({ publicId, deletedAt: { $exists: false } });
  if (!staff) throw notFound('admin/not-found', 'Admin not found');
  return staff;
}

async function otherActiveSupers(excludeId: string): Promise<number> {
  return StaffModel.countDocuments({
    _id: { $ne: excludeId },
    disabled: { $ne: true },
    deletedAt: { $exists: false },
    $or: [{ roleKey: 'super' }, { 'role.id': 'ROLE-CEO' }],
  });
}

function isSuper(s: { roleKey?: string; role?: { id?: string } }): boolean {
  return s.roleKey === 'super' || s.role?.id === 'ROLE-CEO';
}

export async function updateAdmin(
  publicId: string,
  patch: { name?: string; email?: string; roleKey?: string },
  actor: AccessStaff,
) {
  const staff = await loadAdmin(publicId);
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name.length < 2) throw unprocessable('Enter the full name.', { name: 'Required' });
    set.name = name;
  }
  if (patch.email !== undefined) {
    const email = patch.email.trim().toLowerCase();
    if (!email.includes('@')) throw unprocessable('Enter a work email.', { email: 'Invalid' });
    if (email !== staff.email) {
      const clash = await StaffModel.exists({ email, _id: { $ne: staff._id } });
      if (clash) throw conflict('conflict/duplicate', 'Another admin uses that email.');
      set.email = email;
    }
  }
  let roleChange: Awaited<ReturnType<typeof roleAssignment>> | null = null;
  if (patch.roleKey !== undefined && patch.roleKey.trim() !== consoleRoleKey(staff)) {
    roleChange = await roleAssignment(patch.roleKey);
    if (isSuper(staff) && roleChange.roleKey !== 'super' && !staff.disabled && !(await otherActiveSupers(String(staff._id)))) {
      throw conflict('admin/last-super', 'Keep at least one active Super admin.');
    }
    Object.assign(set, {
      roleKey: roleChange.roleKey,
      role: roleChange.role,
      permissions: roleChange.permissions,
      actions: roleChange.actions,
      actionsOverride: roleChange.actionsOverride,
    });
  }
  if (!Object.keys(set).length) return adminRow(staff.toObject());
  const before = { name: staff.name, email: staff.email, roleKey: consoleRoleKey(staff) };
  let updated;
  try {
    updated = await StaffModel.findByIdAndUpdate(staff._id, { $set: set }, { new: true, runValidators: true }).lean<StaffShape>();
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw conflict('conflict/duplicate', 'Another admin uses that email.');
    throw err;
  }
  if (!updated) throw notFound('admin/not-found', 'Admin not found');
  await audit(actor, 'Admin edited', { type: 'Admin', id: staff.publicId, label: updated.email }, {
    before,
    after: { name: updated.name, email: updated.email, roleKey: consoleRoleKey(updated) },
  });
  return adminRow(updated);
}

export async function setAdminDisabled(publicId: string, disabled: boolean, actor: AccessStaff, reason?: string) {
  const staff = await loadAdmin(publicId);
  if (disabled) {
    if (String(staff._id) === actor.id) throw conflict('admin/self', 'You cannot disable yourself.');
    if (isSuper(staff) && !staff.disabled && !(await otherActiveSupers(String(staff._id)))) {
      throw conflict('admin/last-super', 'This is the only active Super admin.');
    }
  }
  if (Boolean(staff.disabled) === disabled) return adminRow(staff.toObject());
  const updated = await StaffModel.findByIdAndUpdate(
    staff._id,
    disabled ? { $set: { disabled: true, disabledAt: new Date() } } : { $set: { disabled: false }, $unset: { disabledAt: 1 } },
    { new: true },
  ).lean<StaffShape>();
  if (!updated) throw notFound('admin/not-found', 'Admin not found');
  await audit(actor, disabled ? 'Admin disabled' : 'Admin enabled', { type: 'Admin', id: staff.publicId, label: staff.email }, { reason });
  return adminRow(updated);
}

export async function deleteAdmin(publicId: string, actor: AccessStaff, reason?: string) {
  const staff = await loadAdmin(publicId);
  if (String(staff._id) === actor.id) throw conflict('admin/self', 'You cannot delete your own account.');
  if (isSuper(staff) && !staff.disabled && !(await otherActiveSupers(String(staff._id)))) {
    throw conflict('admin/last-super', 'This is the only Super admin.');
  }
  const email = staff.email;
  await StaffModel.updateOne(
    { _id: staff._id },
    {
      $set: {
        disabled: true,
        disabledAt: staff.disabledAt ?? new Date(),
        deletedAt: new Date(),
        deletedBy: actor.publicId || actor.id,
        deletedEmail: email,
        email: `deleted-${staff.publicId.toLowerCase()}@deleted.invalid`,
      },
      $unset: { whatsapp: 1, ssoSubject: 1 },
    },
  );
  await audit(actor, 'Admin deleted', { type: 'Admin', id: staff.publicId, label: email }, { reason });
  return { ok: true as const, id: staff.publicId };
}
