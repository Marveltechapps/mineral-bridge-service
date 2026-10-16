/** Admin contract §3.3 `PermissionModule`. `support` is the "Support†" column (A-1). */
export const PERMISSION_MODULES = [
  'orders',
  'vault',
  'pricing',
  'auctions',
  'users',
  'compliance',
  'content',
  'financial',
  'settings',
  'support',
] as const;
export type PermissionModule = (typeof PERMISSION_MODULES)[number];

export const ACCESS_LEVELS = ['none', 'view', 'edit'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export type Permissions = Record<PermissionModule, AccessLevel>;

export interface StaffRoleRef {
  /** `ROLE-DESK`, `ROLE-CEO`, … */
  id: string;
  name: string;
  scope: string;
}

export interface StaffShape {
  /** Human-readable id used on the admin wire: `STF-2026-ABCDE`. */
  publicId: string;
  email: string;
  passwordHash: string;
  /** Last N password hashes (newest first, includes the current one) for the "not one of the last 5" rule. */
  passwordHistory: string[];
  passwordChangedAt?: Date;
  phone?: string;
  name: string;
  desk: string;
  role: StaffRoleRef;
  permissions: Permissions;
  disabled: boolean;
  disabledAt?: Date;
  /** Keys such as `offers_awaiting_approval`; missing keys fall back to defaults. */
  notificationPreferences: Record<string, boolean>;
  ssoSubject?: string;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface StaffRecord extends StaffShape {
  id: string;
}

export const PASSWORD_HISTORY_DEPTH = 5;
export const STAFF_PASSWORD_MIN_LENGTH = 12;

export const DEFAULT_NOTIFICATION_PREFERENCES: Record<string, { label: string; enabled: boolean }> = {
  offers_awaiting_approval: { label: 'Firm offers awaiting my approval', enabled: true },
  auction_flagged: { label: 'Auction flagged for risk', enabled: true },
  daily_settlement_digest: { label: 'Daily settlement digest', enabled: false },
  lot_held_over_45_days: { label: 'Lot held over 45 days', enabled: true },
};
