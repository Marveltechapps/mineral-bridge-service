import {
  PERMISSION_MODULES,
  type AccessLevel,
  type Permissions,
  type PermissionModule,
  type StaffRoleRef,
} from './staff.types.js';

/**
 * Default role grants — admin contract §8 "Authorisation matrix" (mirrors the console's
 * `settingsData.ts`). Used to seed staff and, later, the Settings → Roles screen (#129/#130).
 *
 * A-1 (product to confirm): Support, Partners, Audit, Analytics, LC, Collab and Chain have no
 * column in the original matrix. Support† is its own module; the others are routed as
 * Partners → orders, LC/Chain/Analytics → financial, Collab → orders, Audit → settings:view.
 * See `MODULE_FOR_UNCONFIRMED_SCREENS`.
 */
export interface DefaultRole extends StaffRoleRef {
  seats: number;
  access: Permissions;
}

const E: AccessLevel = 'edit';
const V: AccessLevel = 'view';
const N: AccessLevel = 'none';

/** Column order: Orders, Vault, Pricing, Auctions, Users, Compliance, Content, Financial, Settings, Support†. */
function row(levels: [AccessLevel, AccessLevel, AccessLevel, AccessLevel, AccessLevel, AccessLevel, AccessLevel, AccessLevel, AccessLevel, AccessLevel]): Permissions {
  return Object.fromEntries(PERMISSION_MODULES.map((m, i) => [m, levels[i]!])) as Permissions;
}

export const DEFAULT_ROLES: readonly DefaultRole[] = [
  {
    id: 'ROLE-CEO',
    name: 'CEO / Super Admin',
    scope: 'Full platform access',
    seats: 2,
    access: row([E, E, E, E, E, E, E, E, E, E]),
  },
  {
    id: 'ROLE-DESK',
    name: 'Trading Desk Manager',
    scope: 'Prices consignments, runs the vault',
    seats: 3,
    access: row([E, E, E, E, V, V, N, V, N, V]),
  },
  {
    id: 'ROLE-COMPLIANCE',
    name: 'Compliance Officer',
    scope: 'KYC, documents, disputes',
    seats: 2,
    access: row([V, V, N, V, V, E, N, V, N, V]),
  },
  {
    id: 'ROLE-CONTENT',
    name: 'Content Manager',
    scope: 'Academy and marketing',
    seats: 2,
    access: row([N, N, N, N, N, N, E, N, N, N]),
  },
  {
    id: 'ROLE-SUPPORT',
    name: 'Support Agent',
    scope: 'Tickets, read-only records',
    seats: 6,
    access: row([V, N, N, N, V, N, N, N, N, E]),
  },
  {
    id: 'ROLE-CLERK',
    name: 'Data Entry Clerk',
    scope: 'Vault intake, account creation',
    seats: 4,
    access: row([V, E, N, N, V, N, N, N, N, N]),
  },
] as const;

/** Where screens without their own matrix column are authorised (A-1, unconfirmed). */
export const MODULE_FOR_UNCONFIRMED_SCREENS: Record<string, { module: PermissionModule; level: 'view' | 'edit' }> = {
  partners: { module: 'orders', level: 'view' },
  collab: { module: 'orders', level: 'view' },
  lc: { module: 'financial', level: 'view' },
  chain: { module: 'financial', level: 'view' },
  analytics: { module: 'financial', level: 'view' },
  audit: { module: 'settings', level: 'view' },
};

export const SUPER_ADMIN_ROLE_ID = 'ROLE-CEO';

export function getDefaultRole(roleId: string): DefaultRole | undefined {
  return DEFAULT_ROLES.find((r) => r.id === roleId);
}

export function findDefaultRoleByName(name: string): DefaultRole | undefined {
  const needle = name.trim().toLowerCase();
  return DEFAULT_ROLES.find((r) => r.name.toLowerCase() === needle);
}

/** A fresh copy so callers can mutate it (e.g. per-person overrides) without touching the matrix. */
export function permissionsForRole(roleId: string): Permissions {
  const role = getDefaultRole(roleId);
  if (!role) throw new Error(`Unknown default role: ${roleId}`);
  return { ...role.access };
}

export function noPermissions(): Permissions {
  return row([N, N, N, N, N, N, N, N, N, N]);
}
