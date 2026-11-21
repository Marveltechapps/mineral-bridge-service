import type { Types } from 'mongoose';

export const USER_ROLES = ['buyer', 'seller', 'both', 'bank_operator'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * Canonical (stored) KYC status. Per-client vocabularies are mapped at the edge:
 *   mobile → identical (`none | pending | verified | rejected`)
 *   web    → `none` ⇄ `unverified` (W-4)
 * A `resubmission_required` review outcome is stored on the submission; the user-level status
 * is `rejected` with `retryAllowed: true`.
 */
export const KYC_STATUSES = ['none', 'pending', 'verified', 'rejected'] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];
export type WebKycStatus = 'unverified' | 'pending' | 'verified' | 'rejected';

export type Tier = 1 | 2 | 3;
export const TIERS: readonly Tier[] = [1, 2, 3];
export const TIER_LABELS: Record<Tier, { tag: string; name: string }> = {
  1: { tag: 'TIER 1', name: 'Individual' },
  2: { tag: 'TIER 2', name: 'Small group / SME' },
  3: { tag: 'TIER 3', name: 'Registered company' },
};

export const LANGUAGES = ['en', 'ha', 'yo', 'ig', 'fr'] as const;
export type Language = (typeof LANGUAGES)[number];
export const CURRENCY_PREFS = ['USD', 'NGN', 'EUR', 'GBP'] as const;
export type CurrencyPref = (typeof CURRENCY_PREFS)[number];

export type AddressKind = 'pickup' | 'delivery';

export type AccountStatus = 'active' | 'suspended' | 'closed';
export type SignInMethod = 'whatsapp' | 'sms' | 'email';
export type BuyerType = 'refinery' | 'house' | 'industry' | 'jewel' | 'investor' | 'wholesale';
/** `form` is legacy; API contract uses `exporter` (both accepted). */
export type SellerType = 'asm' | 'industrial' | 'coop' | 'dealer' | 'form' | 'exporter' | 'scrap';

export interface UserAddress {
  /** `adr_…` */
  id: string;
  kind: AddressKind;
  label: string;
  streetAddress: string;
  city: string;
  region: string;
  country: string;
  /** Receiver company (shipping form `org`). */
  org?: string;
  contactPerson?: string;
  contactPhone?: string;
  isDefault: boolean;
  importPermitNumber?: string;
  source?: 'profile' | 'manual';
  geo?: { lat: number; lng: number };
  savedAt: Date;
}

export interface UserBusiness {
  buyerType?: BuyerType;
  sellerType?: SellerType;
  name?: string;
  registrationNo?: string;
}

export interface UserSuspension {
  reason: string;
  at: Date;
  by?: { kind: string; id: string; name?: string; role?: string };
  liftedAt?: Date;
  liftedBy?: { kind: string; id: string; name?: string; role?: string };
}

export interface UserStats {
  orders?: number;
  sells?: number;
  openOrders?: number;
  lastOrderAt?: Date;
}

export interface UserPreferences {
  language: Language;
  currency: CurrencyPref;
  units: 'metric' | 'imperial';
  alerts: { bids: boolean; orders: boolean; lots: boolean; marketing: boolean };
  biometric: boolean;
}

export interface UserProfile {
  fullName?: string;
  displayName?: string;
  /** `YYYY-MM-DD` */
  dateOfBirth?: string;
  avatarUrl?: string;
  /** ISO 3166-1 alpha-2 */
  countryCode?: string;
  companyName?: string;
  businessRegistrationNumber?: string;
}

/** The persisted shape (no `id`). */
export interface UserShape {
  /** Public customer number `C-…` (unique once backfilled). */
  customerNo?: string;
  phone?: string;
  phoneVerifiedAt?: Date;
  whatsapp?: string;
  whatsappVerifiedAt?: Date;
  email?: string;
  emailVerifiedAt?: Date;
  signInMethod?: SignInMethod;

  passwordHash?: string;
  passwordChangedAt?: Date;

  roles: UserRole[];
  business?: UserBusiness;

  kycStatus: KycStatus;
  kycReference?: string;
  kycVerifiedAt?: Date;
  kycSubmissionId?: Types.ObjectId;

  tier: Tier;
  /** Set once the user has explicitly picked a tier (drives mobile `onboarding.nextStep`). */
  tierChosenAt?: Date;

  accountStatus: AccountStatus;
  suspension?: UserSuspension;

  profile: UserProfile;
  preferences: UserPreferences;
  addresses: UserAddress[];
  acceptedTerms?: { version: string; at: Date };

  pinHash?: string;
  pinSetAt?: Date;
  pinFailCount: number;
  pinLockedUntil?: Date;

  isDeleted: boolean;
  deletedAt?: Date;
  deletionScheduledAt?: Date;
  deletionReason?: string;

  stats?: UserStats;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** A plain object returned by the repository. `id` is the ObjectId as a string. */
export interface UserRecord extends UserShape {
  id: string;
}

export interface CreateUserInput {
  phone?: string;
  phoneVerified?: boolean;
  email?: string;
  emailVerified?: boolean;
  roles?: UserRole[];
  profile?: UserProfile;
  acceptedTerms?: { version: string };
  tier?: Tier;
}

export const PIN_LENGTH = 4;
export const PIN_MAX_FAILURES = 5;
export const PIN_LOCK_MINUTES = 30;
