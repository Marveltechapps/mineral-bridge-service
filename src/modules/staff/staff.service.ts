import { isValidObjectId } from 'mongoose';
import { conflict, notFound, unprocessable } from '../../common/errors/app-error.js';
import { hashPassword, verifyPassword } from '../../common/utils/crypto.js';
import { businessRef } from '../../common/utils/ids.js';
import { getDefaultRole, noPermissions, permissionsForRole } from './default-roles.js';
import { StaffModel } from './staff.model.js';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  PASSWORD_HISTORY_DEPTH,
  STAFF_PASSWORD_MIN_LENGTH,
  type AccessLevel,
  type PermissionModule,
  type Permissions,
  type StaffRecord,
  type StaffRoleRef,
  type StaffShape,
} from './staff.types.js';

type LeanStaff = StaffShape & { _id: { toString(): string } };

function toRecord(raw: LeanStaff | null): StaffRecord | null {
  if (!raw) return null;
  const { _id, passwordHash: _ph, passwordHistory: _hist, ...rest } = raw as LeanStaff & Record<string, unknown>;
  void _ph;
  void _hist;
  return { ...(rest as unknown as StaffShape), id: _id.toString() } as StaffRecord;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

const LEVEL_RANK: Record<AccessLevel, number> = { none: 0, view: 1, edit: 2 };

/** `edit` satisfies `view`; `none` satisfies nothing. */
export function accessSatisfies(have: AccessLevel | undefined, need: 'view' | 'edit'): boolean {
  return LEVEL_RANK[have ?? 'none'] >= LEVEL_RANK[need];
}

export function permissionFor(
  permissions: Partial<Record<PermissionModule, AccessLevel>>,
  module: PermissionModule,
): AccessLevel {
  return permissions[module] ?? 'none';
}

/** Admin contract: ≥ 12 characters (the "not one of the last 5" rule is checked with the history). */
export function validateStaffPassword(password: string): string | null {
  if (password.length < STAFF_PASSWORD_MIN_LENGTH) {
    return `Use at least ${STAFF_PASSWORD_MIN_LENGTH} characters.`;
  }
  if (password.length > 128) return 'Use at most 128 characters.';
  return null;
}

export async function isPasswordInHistory(password: string, history: readonly string[]): Promise<boolean> {
  for (const hash of history.slice(0, PASSWORD_HISTORY_DEPTH)) {
    if (await verifyPassword(password, hash)) return true;
  }
  return false;
}

export function staffEmailDomains(): string[] {
  return (process.env.ADMIN_STAFF_EMAIL_DOMAINS ?? 'mineralbridge.co.ke,mineralbridge.com,mineralbridge.co')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

export function isStaffEmailDomainAllowed(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  return Boolean(domain && staffEmailDomains().includes(domain));
}

let dummyHash: Promise<string> | null = null;
/** Compared against when the email is unknown so response time does not reveal account existence. */
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('not-a-real-password-for-timing-equalisation');
  return dummyHash;
}

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

export interface CreateStaffInput {
  email: string;
  password: string;
  name: string;
  phone?: string;
  desk?: string;
  /** Seed from the default matrix… */
  roleId?: string;
  /** …or supply an explicit role + permissions (e.g. custom roles later). */
  role?: StaffRoleRef;
  permissions?: Permissions;
}

export async function createStaff(input: CreateStaffInput): Promise<StaffRecord> {
  const problem = validateStaffPassword(input.password);
  if (problem) throw unprocessable('Password does not meet the policy.', { password: problem });

  let role: StaffRoleRef;
  let permissions: Permissions;
  if (input.roleId) {
    const def = getDefaultRole(input.roleId);
    if (!def) throw unprocessable('Unknown role.', { roleId: 'Unknown role' });
    role = { id: def.id, name: def.name, scope: def.scope };
    permissions = permissionsForRole(def.id);
  } else if (input.role) {
    role = input.role;
    permissions = input.permissions ?? noPermissions();
  } else {
    throw unprocessable('A role is required.', { roleId: 'Required' });
  }

  const passwordHash = await hashPassword(input.password);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const doc = await StaffModel.create({
        publicId: businessRef('STF'),
        email: input.email.toLowerCase(),
        passwordHash,
        passwordHistory: [passwordHash],
        passwordChangedAt: new Date(),
        phone: input.phone,
        name: input.name,
        desk: input.desk ?? '',
        role,
        permissions,
      });
      return toRecord(doc.toObject() as unknown as LeanStaff)!;
    } catch (err) {
      const e = err as { code?: number; keyPattern?: Record<string, unknown> };
      if (e.code === 11000 && e.keyPattern?.email) {
        throw conflict('conflict/duplicate', 'A staff member with that email already exists.');
      }
      if (e.code === 11000 && e.keyPattern?.publicId) continue; // regenerate id
      throw err;
    }
  }
  throw new Error('Could not allocate a unique staff id');
}

export async function findStaffById(id: string): Promise<StaffRecord | null> {
  if (!isValidObjectId(id)) return null;
  return toRecord(await StaffModel.findById(id).lean<LeanStaff>());
}

export async function findStaffByEmail(email: string): Promise<StaffRecord | null> {
  return toRecord(await StaffModel.findOne({ email: email.toLowerCase().trim() }).lean<LeanStaff>());
}

async function findHashes(
  match: { _id?: string; email?: string },
): Promise<{ record: StaffRecord; passwordHash: string; passwordHistory: string[] } | null> {
  const raw = await StaffModel.findOne(match)
    .select('+passwordHash +passwordHistory')
    .lean<LeanStaff>();
  if (!raw) return null;
  return {
    record: toRecord(raw)!,
    passwordHash: raw.passwordHash,
    passwordHistory: raw.passwordHistory ?? [],
  };
}

/**
 * Email + password check for sign-in. Returns the staff record (even if disabled — the caller
 * decides how to answer, but only *after* a correct password so nothing leaks) or null.
 */
export async function verifyCredentials(email: string, password: string): Promise<StaffRecord | null> {
  const found = await findHashes({ email: email.toLowerCase().trim() });
  if (!found) {
    await verifyPassword(password, await getDummyHash());
    return null;
  }
  return (await verifyPassword(password, found.passwordHash)) ? found.record : null;
}

export async function verifyStaffPassword(staffId: string, password: string): Promise<boolean> {
  if (!isValidObjectId(staffId)) return false;
  const found = await findHashes({ _id: staffId });
  if (!found) return false;
  return verifyPassword(password, found.passwordHash);
}

/**
 * Sets a new password (reset flow). Enforces the policy and the last-5 history rule.
 * Callers revoke the staff member's sessions afterwards.
 */
export async function setStaffPassword(staffId: string, newPassword: string): Promise<void> {
  const problem = validateStaffPassword(newPassword);
  if (problem) throw unprocessable('Password does not meet the policy.', { newPassword: problem });
  const found = isValidObjectId(staffId) ? await findHashes({ _id: staffId }) : null;
  if (!found) throw notFound('resource/not-found', 'Staff member not found');

  const history = [found.passwordHash, ...found.passwordHistory.filter((h) => h !== found.passwordHash)];
  if (await isPasswordInHistory(newPassword, history)) {
    throw unprocessable('Choose a password you have not used recently.', {
      newPassword: `Must differ from your last ${PASSWORD_HISTORY_DEPTH} passwords`,
    });
  }
  const passwordHash = await hashPassword(newPassword);
  await StaffModel.updateOne(
    { _id: staffId },
    {
      $set: {
        passwordHash,
        passwordHistory: [passwordHash, ...history].slice(0, PASSWORD_HISTORY_DEPTH),
        passwordChangedAt: new Date(),
      },
    },
  );
}

export async function recordStaffLogin(staffId: string, now = new Date()): Promise<void> {
  await StaffModel.updateOne({ _id: staffId }, { $set: { lastLoginAt: now } });
}

export async function updateStaffProfile(
  staffId: string,
  patch: { name?: string; phone?: string; desk?: string },
): Promise<StaffRecord> {
  const $set: Record<string, string> = {};
  if (patch.name) $set.name = patch.name;
  if (patch.phone) $set.phone = patch.phone;
  if (patch.desk !== undefined) $set.desk = patch.desk;
  const updated = toRecord(
    await StaffModel.findByIdAndUpdate(staffId, { $set }, { new: true, runValidators: true }).lean<LeanStaff>(),
  );
  if (!updated) throw notFound('resource/not-found', 'Staff member not found');
  return updated;
}

export async function setStaffDisabled(staffId: string, disabled: boolean): Promise<StaffRecord> {
  const updated = toRecord(
    await StaffModel.findByIdAndUpdate(
      staffId,
      disabled ? { $set: { disabled: true, disabledAt: new Date() } } : { $set: { disabled: false }, $unset: { disabledAt: 1 } },
      { new: true },
    ).lean<LeanStaff>(),
  );
  if (!updated) throw notFound('resource/not-found', 'Staff member not found');
  return updated;
}

export function notificationPreferenceList(
  stored: Record<string, boolean>,
): Array<{ key: string; label: string; enabled: boolean }> {
  return Object.entries(DEFAULT_NOTIFICATION_PREFERENCES).map(([key, def]) => ({
    key,
    label: def.label,
    enabled: stored[key] ?? def.enabled,
  }));
}

export async function setNotificationPreferences(
  staffId: string,
  prefs: Record<string, boolean>,
): Promise<StaffRecord> {
  const $set: Record<string, boolean> = {};
  for (const [key, enabled] of Object.entries(prefs)) {
    if (!(key in DEFAULT_NOTIFICATION_PREFERENCES)) {
      throw unprocessable('Unknown notification preference.', { preferences: `Unknown key ${key}` });
    }
    $set[`notificationPreferences.${key}`] = enabled;
  }
  const updated = toRecord(
    await StaffModel.findByIdAndUpdate(staffId, { $set }, { new: true }).lean<LeanStaff>(),
  );
  if (!updated) throw notFound('resource/not-found', 'Staff member not found');
  return updated;
}
