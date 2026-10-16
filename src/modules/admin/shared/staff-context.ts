import type { Request, RequestHandler } from 'express';
import { forbidden } from '../../../common/errors/app-error.js';
import { getStaffContext, requireCsrf, requireStaff, requireUnlockedConsole } from '../../auth/auth.middleware.js';
import { accessSatisfies } from '../../staff/staff.service.js';
import type { AccessLevel } from '../../staff/staff.types.js';
import type { AuditActor } from '../../audit/audit.service.js';

/**
 * Bridge between the admin domain modules and the auth/session/staff modules (owned elsewhere).
 * Everything stored by the admin domain references staff by their wire id (`STF-…` = `publicId`),
 * never by the Mongo `_id` that `req.actor.staffId` carries.
 */
export type StaffIdentity = {
  /** Wire id (`StaffRecord.publicId`). */
  staffId: string;
  /** Mongo _id as string (what `req.actor.staffId` holds). */
  mongoId: string;
  name: string;
  initials: string;
  email: string;
  phone?: string;
  role: string;
  roleId: string;
  permissions: Record<string, AccessLevel>;
  sessionId: string;
  sessionState: 'active' | 'locked';
};

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '??';
  const first = parts[0]![0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1]![0] ?? '' : (parts[0]![1] ?? '');
  return `${first}${last}`.toUpperCase();
}

export function staffActor(req: Request): StaffIdentity {
  const { staff, session } = getStaffContext(req);
  return {
    staffId: staff.publicId,
    mongoId: staff.id,
    name: staff.name,
    initials: initialsOf(staff.name),
    email: staff.email,
    phone: staff.phone,
    role: staff.role.name,
    roleId: staff.role.id,
    permissions: staff.permissions as Record<string, AccessLevel>,
    sessionId: session.publicId,
    sessionState: session.state as 'active' | 'locked',
  };
}

export function auditActor(req: Request): AuditActor & { staffId: string } {
  const a = staffActor(req);
  return { staffId: a.staffId, name: a.name, initials: a.initials, role: a.role, roleId: a.roleId };
}

export function hasAccess(permissions: Record<string, AccessLevel | undefined>, module: string, level: 'view' | 'edit'): boolean {
  return accessSatisfies(permissions[module], level);
}

/** Four-eyes rule for money-moving decisions: the approver must not be the record's creator. */
export function assertFourEyes(req: Request, creatorIds: Array<string | null | undefined>): void {
  const me = staffActor(req).staffId;
  if (creatorIds.some((id) => id && id === me)) {
    throw forbidden('auth/four-eyes', 'A second approver is required: you created this record.');
  }
}

/** Session cookie + unlocked-console gate (or locked-allowed) chained for the route builder. */
export function adminSession(opts: { allowLocked?: boolean } = {}): RequestHandler {
  return (req, res, next) => {
    requireStaff(req, res, (err?: unknown) => {
      if (err) return next(err);
      if (opts.allowLocked) return next();
      requireUnlockedConsole(req, res, next);
    });
  };
}

export const csrfProtect: RequestHandler = requireCsrf;
