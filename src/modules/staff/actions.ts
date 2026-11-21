import type { RequestHandler } from 'express';
import { forbidden, unauthorized } from '../../common/errors/app-error.js';
import { findStaffById } from './staff.service.js';
import type { AccessLevel, PermissionModule, Permissions } from './staff.types.js';

/**
 * Dashboard action keys (doc 04 / 07 / 12). `super` staff always passes.
 * Module-level permissions remain for `/admin/v1`; `/v2/admin` uses these.
 */
export const STAFF_ACTIONS = [
  'ops',
  'trading',
  'auction',
  'kyc',
  'suspend',
  'inspection',
  'finance',
  'logistics',
  'catalogue',
  'support',
  'remind',
  'settings',
] as const;

export type StaffAction = (typeof STAFF_ACTIONS)[number];

/** Default action sets by roleKey (editable later via role CRUD). */
export const DEFAULT_ACTIONS_BY_ROLE: Record<string, readonly StaffAction[]> = {
  super: STAFF_ACTIONS,
  ops: ['ops', 'trading', 'logistics', 'remind', 'support'],
  trading: ['trading', 'auction', 'catalogue', 'remind'],
  compliance: ['kyc', 'suspend', 'support'],
  inspection: ['inspection', 'ops'],
  finance: ['finance', 'ops'],
  logistics: ['logistics', 'ops'],
  catalogue: ['catalogue'],
  support: ['support', 'remind'],
};

export function actionsForRoleKey(roleKey: string | undefined): StaffAction[] {
  if (!roleKey) return [];
  if (roleKey === 'super') return [...STAFF_ACTIONS];
  return [...(DEFAULT_ACTIONS_BY_ROLE[roleKey] ?? [])];
}

type ActionSubject = {
  roleKey?: string;
  actions?: string[];
  actionsOverride?: boolean;
  role?: { id?: string; name?: string };
};

/** The action list that applies to a staff member: the stored override when set, else the role default. */
export function effectiveActions(staff: ActionSubject): string[] {
  if (staff.roleKey === 'super' || staff.role?.id === 'ROLE-CEO' || staff.role?.name === 'CEO') return [...STAFF_ACTIONS];
  if (staff.actionsOverride) return [...(staff.actions ?? [])];
  return staff.actions?.length ? [...staff.actions] : actionsForRoleKey(staff.roleKey);
}

export function staffHasAction(staff: ActionSubject, action: StaffAction): boolean {
  return effectiveActions(staff).includes(action);
}

const ACTION_MODULE_FALLBACK: Partial<Record<StaffAction, PermissionModule>> = {
  kyc: 'compliance',
  suspend: 'compliance',
  finance: 'financial',
  auction: 'auctions',
  catalogue: 'content',
  support: 'support',
  remind: 'support',
  settings: 'settings',
  ops: 'orders',
  trading: 'orders',
  logistics: 'orders',
  inspection: 'vault',
};

function moduleAllows(permissions: Permissions, module: PermissionModule): boolean {
  const level = (permissions[module] ?? 'none') as AccessLevel;
  return level !== 'none';
}

/**
 * Gate for `/v2/admin`. Chain after `requireStaff` (+ CSRF on mutations).
 * Implies unlocked console.
 */
export function requireAction(...needed: StaffAction[]): RequestHandler {
  return async (req, _res, next) => {
    try {
      if (req.actor?.kind !== 'staff') {
        throw unauthorized('auth/session-expired', 'Your session has expired. Sign in again.');
      }
      if (req.actor.sessionState === 'locked') {
        throw unauthorized('auth/console-locked', 'The console is locked. Enter your password to continue.');
      }

      const staff = await findStaffById(req.actor.staffId);
      if (!staff || staff.disabled) {
        throw unauthorized('auth/session-expired', 'Your session has expired. Sign in again.');
      }

      const allowed = needed.some((action) => {
        if (staffHasAction(staff, action)) return true;
        if (staff.actionsOverride) return false;
        const mod = ACTION_MODULE_FALLBACK[action];
        return mod ? moduleAllows(staff.permissions, mod) : false;
      });

      if (!allowed) {
        throw forbidden('auth/forbidden', 'Your role does not permit this action.', {
          details: { required: needed },
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
