import type { Types } from 'mongoose';

export type CustomerClient = 'mobile' | 'web';

export interface DeviceInfo {
  /** Stable per install (mobile `X-Device-Id`) or a browser fingerprint id. */
  id?: string;
  platform?: string;
  name?: string;
  pushToken?: string;
  userAgent?: string;
  ip?: string;
  location?: string;
}

export type RevokeReason =
  | 'sign_out'
  | 'revoked_by_user'
  | 'reuse_detected'
  | 'password_changed'
  | 'account_deleted'
  | 'replaced'
  | 'admin';

export interface CustomerSessionShape {
  /** `ses_…` — what clients see, and what the access token's `sid` claim carries. */
  publicId: string;
  userId: Types.ObjectId;
  client: CustomerClient;
  /** One family per login chain; reuse detection revokes every session in it. */
  familyId: string;
  device: DeviceInfo;
  refreshTokenHash: string;
  /** Hashes of tokens already rotated out (newest last, capped). Distinguishes replay from forgery. */
  previousHashes: string[];
  /** Web only: the immediately previous token stays valid until `graceUntil` (W-10). */
  gracePreviousHash?: string;
  graceUntil?: Date;
  rotationCount: number;
  revokedAt?: Date;
  revokedReason?: RevokeReason;
  /**
   * Web "keep me signed in". True (or absent on older sessions) keeps the refresh
   * cookie for the existing refresh TTL. False makes it a browser session cookie.
   * The server-side absolute expiry is unchanged.
   */
  persistent?: boolean;
  /** Fixed at login (login + refresh TTL); rotation does not extend it. */
  absoluteExpiresAt: Date;
  lastUsedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomerSessionRecord extends CustomerSessionShape {
  id: string;
}

export type StaffSessionState = 'active' | 'locked';

export interface StaffSessionShape {
  /** `SES-…` */
  publicId: string;
  staffId: Types.ObjectId;
  sessionTokenHash: string;
  csrfTokenHash: string;
  state: StaffSessionState;
  /** Extended on sign-in, refresh and unlock — not by background polling. */
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  lockedAt?: Date;
  failedUnlockCount: number;
  device: DeviceInfo;
  lastUsedAt: Date;
  revokedAt?: Date;
  revokedReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface StaffSessionRecord extends StaffSessionShape {
  id: string;
}
