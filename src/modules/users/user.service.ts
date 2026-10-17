import {
  AppError,
  conflict,
  locked,
  notFound,
  unprocessable,
} from '../../common/errors/app-error.js';
import { hashPassword, verifyPassword } from '../../common/utils/crypto.js';
import { isDuplicateKeyError, userRepository } from './user.repository.js';
import {
  PIN_LENGTH,
  PIN_LOCK_MINUTES,
  PIN_MAX_FAILURES,
  TIERS,
  type CreateUserInput,
  type KycStatus,
  type Tier,
  type UserAddress,
  type UserPreferences,
  type UserProfile,
  type UserRecord,
  type UserRole,
  type WebKycStatus,
} from './user.types.js';

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit-tested without a database)
// ---------------------------------------------------------------------------------------------

/** Customer password policy (web contract §7): ≥ 10 chars, ≥ 1 uppercase, ≥ 1 digit or symbol. */
export function validateCustomerPassword(password: string): string | null {
  if (password.length < 10) return 'Use at least 10 characters.';
  if (password.length > 128) return 'Use at most 128 characters.';
  if (!/[A-Z]/.test(password)) return 'Include at least one uppercase letter.';
  if (!/[0-9]|[^A-Za-z0-9\s]/.test(password)) return 'Include at least one digit or symbol.';
  return null;
}

export function isValidPinFormat(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);
}

/** Rejects repeated (`1111`) and sequential (`1234`, `4321`) PINs. */
export function isWeakPin(pin: string): boolean {
  if (/^(\d)\1+$/.test(pin)) return true;
  const digits = pin.split('').map(Number);
  const asc = digits.every((d, i) => i === 0 || d === digits[i - 1]! + 1);
  const desc = digits.every((d, i) => i === 0 || d === digits[i - 1]! - 1);
  return asc || desc;
}

export type PinState = 'not_set' | 'locked' | 'ok';

export function evaluatePinState(
  secrets: { pinHash?: string; pinLockedUntil?: Date },
  now: Date,
): PinState {
  if (!secrets.pinHash) return 'not_set';
  if (secrets.pinLockedUntil && secrets.pinLockedUntil.getTime() > now.getTime()) return 'locked';
  return 'ok';
}

export function toWebKycStatus(status: KycStatus): WebKycStatus {
  return status === 'none' ? 'unverified' : status;
}

export function fromWebKycStatus(status: WebKycStatus): KycStatus {
  return status === 'unverified' ? 'none' : status;
}

export function initialsOf(name: string | undefined | null): string {
  if (!name) return '';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  const first = parts[0]![0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1]![0] ?? '' : '';
  return `${first}${last}`.toUpperCase();
}

/** `both` satisfies `buyer` and `seller`; other roles must match exactly. */
export function hasRole(roles: readonly string[], required: UserRole): boolean {
  if (roles.includes(required)) return true;
  return roles.includes('both') && (required === 'buyer' || required === 'seller');
}

/** Which profile fields are padlocked (mobile `lockedFields`). The server is the authority. */
export function lockedFieldsFor(user: Pick<UserRecord, 'phoneVerifiedAt' | 'kycStatus'>): string[] {
  const out: string[] = [];
  if (user.phoneVerifiedAt) out.push('phone');
  if (user.kycStatus === 'verified') out.push('dateOfBirth', 'fullName');
  return out;
}

// ---------------------------------------------------------------------------------------------
// Account deletion guards (orders module registers itself later)
// ---------------------------------------------------------------------------------------------

export interface BlockingOrder {
  id: string;
  reference: string;
  status: string;
}

export type DeletionGuard = (userId: string) => Promise<BlockingOrder[]>;
const deletionGuards: DeletionGuard[] = [];

/** The orders module calls this at boot so deletion is blocked while orders are unsettled. */
export function registerAccountDeletionGuard(guard: DeletionGuard): void {
  deletionGuards.push(guard);
}

export function clearAccountDeletionGuards(): void {
  deletionGuards.length = 0;
}

export const WEB_DELETION_GRACE_DAYS = 7;

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

export async function getUserOrThrow(id: string): Promise<UserRecord> {
  const user = await userRepository.findById(id);
  if (!user) throw notFound('resource/not-found', 'Account not found');
  return user;
}

/** Mobile: phone-only accounts. Unknown numbers become accounts on first verified OTP. */
export async function findOrCreateByVerifiedPhone(
  phone: string,
  defaults: { roles?: UserRole[] } = {},
): Promise<{ user: UserRecord; isNew: boolean }> {
  const existing = await userRepository.findByPhone(phone);
  if (existing) {
    const user = await markVerified(existing, { phone: true });
    return { user, isNew: false };
  }
  try {
    const user = await userRepository.create({
      phone,
      phoneVerified: true,
      roles: defaults.roles ?? ['both'],
    });
    return { user, isNew: true };
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const raced = await userRepository.findByPhone(phone);
      if (raced) return { user: raced, isNew: false };
    }
    throw err;
  }
}

export interface WebRegistrationPayload {
  method: 'mobile' | 'email' | 'whatsapp';
  identifier: string;
  fullName: string;
  role: 'buyer' | 'seller' | 'both';
  companyName?: string;
  country: string;
  acceptedTermsVersion: string;
  /** Verified only when it is the OTP channel. */
  email?: string;
  /** Verified only when it is the OTP channel. */
  phone?: string;
}

/**
 * Web: the account is created when the registration OTP is verified. If the identifier already
 * belongs to an account, that account is simply signed in (the register response must not reveal
 * whether the identifier was known) and the supplied profile is ignored.
 */
export async function findOrCreateFromWebRegistration(
  payload: WebRegistrationPayload,
): Promise<{ user: UserRecord; isNew: boolean }> {
  const isEmail = payload.method === 'email';
  const existing = isEmail
    ? await userRepository.findByEmail(payload.identifier)
    : await userRepository.findByPhone(payload.identifier);
  if (existing) {
    const user = await markVerified(existing, isEmail ? { email: true } : { phone: true });
    return { user, isNew: false };
  }
  const email = payload.email ?? (isEmail ? payload.identifier : undefined);
  const phone = payload.phone ?? (isEmail ? undefined : payload.identifier);
  let storedEmail = email;
  let storedPhone = phone;
  if (storedEmail && !isEmail) {
    const owner = await userRepository.findByEmail(storedEmail);
    if (owner) storedEmail = undefined;
  }
  if (storedPhone && isEmail) {
    const owner = await userRepository.findByPhone(storedPhone);
    if (owner) storedPhone = undefined;
  }
  const input: CreateUserInput = {
    ...(storedPhone ? { phone: storedPhone, phoneVerified: !isEmail } : {}),
    ...(storedEmail ? { email: storedEmail, emailVerified: isEmail } : {}),
    roles: [payload.role],
    profile: {
      fullName: payload.fullName,
      countryCode: payload.country,
      ...(payload.companyName ? { companyName: payload.companyName } : {}),
    },
    acceptedTerms: { version: payload.acceptedTermsVersion },
    tier: 1, // W-11: web users default to Tier 1
  };
  try {
    return { user: await userRepository.create(input), isNew: true };
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const raced = isEmail
        ? await userRepository.findByEmail(payload.identifier)
        : await userRepository.findByPhone(payload.identifier);
      if (raced) return { user: raced, isNew: false };
    }
    throw err;
  }
}

/** Web login: returns the existing account (and marks the channel verified) or null. */
export async function findForWebLogin(
  method: 'mobile' | 'email' | 'whatsapp',
  identifier: string,
): Promise<UserRecord | null> {
  return method === 'email'
    ? userRepository.findByEmail(identifier)
    : userRepository.findByPhone(identifier);
}

export async function markVerified(
  user: UserRecord,
  channels: { phone?: boolean; email?: boolean },
): Promise<UserRecord> {
  const $set: Record<string, Date> = {};
  const now = new Date();
  if (channels.phone && user.phone && !user.phoneVerifiedAt) $set.phoneVerifiedAt = now;
  if (channels.email && user.email && !user.emailVerifiedAt) $set.emailVerifiedAt = now;
  $set.lastLoginAt = now;
  return (await userRepository.update(user.id, { $set })) ?? user;
}

export interface ProfilePatch {
  fullName?: string;
  displayName?: string;
  email?: string | null;
  dateOfBirth?: string;
  phone?: string;
  companyName?: string | null;
  businessRegistrationNumber?: string | null;
  countryCode?: string;
}

export async function updateProfile(userId: string, patch: ProfilePatch): Promise<UserRecord> {
  const user = await getUserOrThrow(userId);
  const locked_ = new Set(lockedFieldsFor(user));
  const fields: Record<string, string> = {};
  for (const key of Object.keys(patch) as Array<keyof ProfilePatch>) {
    if (patch[key] === undefined) continue;
    if (locked_.has(key)) {
      const current = key === 'phone' ? user.phone : user.profile[key as keyof UserProfile];
      if (patch[key] !== current) {
        fields[key] = key === 'phone' ? 'Locked to your verified number' : 'Locked to your verified ID';
      }
    }
  }
  if (Object.keys(fields).length > 0) {
    throw unprocessable('A locked field cannot be changed.', fields);
  }

  const $set: Record<string, unknown> = {};
  const $unset: Record<string, 1> = {};
  const profileKeys: Array<keyof UserProfile> = [
    'fullName',
    'displayName',
    'dateOfBirth',
    'companyName',
    'businessRegistrationNumber',
    'countryCode',
  ];
  for (const k of profileKeys) {
    const v = patch[k as keyof ProfilePatch];
    if (v === undefined) continue;
    if (v === null || v === '') $unset[`profile.${k}`] = 1;
    else $set[`profile.${k}`] = v;
  }
  if (patch.email !== undefined) {
    if (patch.email === null || patch.email === '') {
      $unset.email = 1;
      $unset.emailVerifiedAt = 1;
    } else if (patch.email.toLowerCase() !== user.email) {
      $set.email = patch.email.toLowerCase();
      $unset.emailVerifiedAt = 1;
    }
  }
  const update: Record<string, unknown> = {};
  if (Object.keys($set).length) update.$set = $set;
  if (Object.keys($unset).length) update.$unset = $unset;
  if (Object.keys(update).length === 0) return user;

  try {
    const updated = await userRepository.update(userId, update);
    if (!updated) throw notFound('resource/not-found', 'Account not found');
    return updated;
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw unprocessable('That email is already in use.', { email: 'Already in use' });
    }
    throw err;
  }
}

export async function updatePreferences(
  userId: string,
  patch: {
    language?: UserPreferences['language'];
    currency?: UserPreferences['currency'];
    units?: UserPreferences['units'];
    alerts?: Partial<UserPreferences['alerts']>;
    biometric?: boolean;
  },
): Promise<UserRecord> {
  const $set: Record<string, unknown> = {};
  if (patch.language) $set['preferences.language'] = patch.language;
  if (patch.currency) $set['preferences.currency'] = patch.currency;
  if (patch.units) $set['preferences.units'] = patch.units;
  if (patch.biometric !== undefined) $set['preferences.biometric'] = patch.biometric;
  for (const [k, v] of Object.entries(patch.alerts ?? {})) {
    if (typeof v === 'boolean') $set[`preferences.alerts.${k}`] = v;
  }
  if (Object.keys($set).length === 0) return getUserOrThrow(userId);
  const updated = await userRepository.update(userId, { $set });
  if (!updated) throw notFound('resource/not-found', 'Account not found');
  return updated;
}

export async function setTier(userId: string, tier: Tier): Promise<UserRecord> {
  if (!TIERS.includes(tier)) throw unprocessable('Unknown tier', { tierId: 'Must be 1, 2 or 3' });
  const updated = await userRepository.update(userId, { $set: { tier, tierChosenAt: new Date() } });
  if (!updated) throw notFound('resource/not-found', 'Account not found');
  return updated;
}

// ---- addresses ------------------------------------------------------------------------------

export async function listAddresses(userId: string): Promise<UserAddress[]> {
  return (await getUserOrThrow(userId)).addresses;
}

export async function addAddress(
  userId: string,
  address: Omit<UserAddress, 'id' | 'savedAt'>,
): Promise<UserAddress> {
  const created = await userRepository.addAddress(userId, address);
  if (!created) throw notFound('resource/not-found', 'Account not found');
  return created;
}

export async function updateAddress(
  userId: string,
  addressId: string,
  patch: Partial<Omit<UserAddress, 'id' | 'savedAt'>>,
): Promise<UserAddress> {
  const updated = await userRepository.updateAddress(userId, addressId, patch);
  if (!updated) throw notFound('resource/not-found', 'Address not found');
  return updated;
}

export async function removeAddress(userId: string, addressId: string): Promise<void> {
  if (!(await userRepository.removeAddress(userId, addressId))) {
    throw notFound('resource/not-found', 'Address not found');
  }
}

// ---- PIN --------------------------------------------------------------------------------------

export async function isPinSet(userId: string): Promise<boolean> {
  const s = await userRepository.findSecrets(userId);
  return Boolean(s?.pinHash);
}

/**
 * Sets or changes the transaction PIN (M-12). `currentPin` is required only when one is set.
 * PINs are bcrypt-hashed: a 4-digit space is trivially brute-forced if a plain/sha256 hash leaks.
 */
export async function setPin(userId: string, newPin: string, currentPin?: string): Promise<void> {
  if (!isValidPinFormat(newPin) || isWeakPin(newPin)) {
    throw unprocessable('Choose a PIN that is not sequential or repeated.', {
      newPin: 'Avoid sequential or repeated digits',
    });
  }
  const secrets = await userRepository.findSecrets(userId);
  if (!secrets) throw notFound('resource/not-found', 'Account not found');
  if (secrets.pinHash) {
    if (!currentPin) {
      throw unprocessable('Enter your current PIN.', { currentPin: 'Required' }, 'auth/pin-invalid');
    }
    await verifyPin(userId, currentPin);
  }
  await userRepository.setPin(userId, await hashPassword(newPin));
}

/** Throws `409 auth/pin-not-set`, `423 auth/pin-locked` or `422 auth/pin-invalid`. */
export async function verifyPin(userId: string, pin: string, now = new Date()): Promise<void> {
  const secrets = await userRepository.findSecrets(userId);
  if (!secrets) throw notFound('resource/not-found', 'Account not found');

  const state = evaluatePinState(secrets, now);
  if (state === 'not_set') {
    throw conflict('auth/pin-not-set', 'Set a transaction PIN before continuing.');
  }
  if (state === 'locked') {
    throw locked('auth/pin-locked', `PIN locked for ${PIN_LOCK_MINUTES} minutes after too many failures.`, {
      lockedUntil: secrets.pinLockedUntil!.toISOString(),
    });
  }
  const ok = isValidPinFormat(pin) && (await verifyPassword(pin, secrets.pinHash!));
  if (ok) {
    if (secrets.pinFailCount > 0) await userRepository.resetPinFailures(userId);
    return;
  }
  const result = await userRepository.registerPinFailure(userId, {
    maxFailures: PIN_MAX_FAILURES,
    lockedUntil: new Date(now.getTime() + PIN_LOCK_MINUTES * 60_000),
  });
  if (result.lockedUntil) {
    throw locked('auth/pin-locked', `PIN locked for ${PIN_LOCK_MINUTES} minutes after too many failures.`, {
      lockedUntil: result.lockedUntil.toISOString(),
    });
  }
  throw new AppError({
    status: 422,
    code: 'auth/pin-invalid',
    message: 'Incorrect PIN.',
    fields: { pin: 'Incorrect PIN' },
    details: { attemptsLeft: Math.max(0, PIN_MAX_FAILURES - result.failCount) },
  });
}

// ---- password (web) ---------------------------------------------------------------------------

export async function hasPassword(userId: string): Promise<boolean> {
  return Boolean((await userRepository.findSecrets(userId))?.passwordHash);
}

/**
 * Sets or changes the web password. OTP-only accounts have none yet (W-6), so
 * `currentPassword` is required only when a password exists.
 */
export async function setPassword(
  userId: string,
  newPassword: string,
  currentPassword?: string,
): Promise<void> {
  const problem = validateCustomerPassword(newPassword);
  if (problem) throw unprocessable('Password does not meet the policy.', { newPassword: problem });

  const secrets = await userRepository.findSecrets(userId);
  if (!secrets) throw notFound('resource/not-found', 'Account not found');
  if (secrets.passwordHash) {
    const ok = currentPassword ? await verifyPassword(currentPassword, secrets.passwordHash) : false;
    // 422 (not 401): any 401 makes the web client attempt a token refresh.
    if (!ok) {
      throw unprocessable('Current password is incorrect.', { currentPassword: 'Incorrect password' });
    }
  }
  await userRepository.setPasswordHash(userId, await hashPassword(newPassword));
}

// ---- KYC projection (written by the kyc module) -----------------------------------------------

export async function applyKycStatus(
  userId: string,
  state: {
    status: KycStatus;
    reference?: string;
    submissionId?: string;
    verifiedAt?: Date | null;
    verifiedIdentity?: { fullName?: string; dateOfBirth?: string };
    tier?: Tier;
  },
): Promise<UserRecord | null> {
  const $set: Record<string, unknown> = { kycStatus: state.status };
  const $unset: Record<string, 1> = {};
  if (state.reference) $set.kycReference = state.reference;
  if (state.submissionId) $set.kycSubmissionId = state.submissionId;
  if (state.verifiedAt) $set.kycVerifiedAt = state.verifiedAt;
  if (state.verifiedAt === null) $unset.kycVerifiedAt = 1;
  if (state.verifiedIdentity?.fullName) $set['profile.fullName'] = state.verifiedIdentity.fullName;
  if (state.verifiedIdentity?.dateOfBirth) $set['profile.dateOfBirth'] = state.verifiedIdentity.dateOfBirth;
  if (state.tier) $set.tier = state.tier;
  const update: Record<string, unknown> = { $set };
  if (Object.keys($unset).length) update.$unset = $unset;
  return userRepository.update(userId, update);
}

// ---- deletion ---------------------------------------------------------------------------------

export async function listBlockingOrders(userId: string): Promise<BlockingOrder[]> {
  const all = await Promise.all(deletionGuards.map((g) => g(userId)));
  return all.flat();
}

/** Mobile: immediate soft-delete + anonymise (204). Caller must revoke sessions. */
export async function deleteAccountNow(userId: string, reason?: string): Promise<BlockingOrder[]> {
  const blocking = await listBlockingOrders(userId);
  if (blocking.length > 0) return blocking;
  await userRepository.anonymise(userId, reason);
  return [];
}

/** Web: schedule deletion (202). `anonymiseDueAccounts` completes it. */
export async function scheduleAccountDeletion(
  userId: string,
  reason?: string,
  now = new Date(),
): Promise<{ blocking: BlockingOrder[]; scheduledDeletionAt?: Date }> {
  const blocking = await listBlockingOrders(userId);
  if (blocking.length > 0) return { blocking };
  const at = new Date(now.getTime() + WEB_DELETION_GRACE_DAYS * 86_400_000);
  await userRepository.scheduleDeletion(userId, at, reason);
  return { blocking: [], scheduledDeletionAt: at };
}

/** Job entry point: anonymises accounts whose grace period has elapsed. */
export async function anonymiseDueAccounts(now = new Date()): Promise<number> {
  const due = await userRepository.findDueForDeletion(now);
  let done = 0;
  for (const u of due) {
    if ((await listBlockingOrders(u.id)).length > 0) continue;
    if (await userRepository.anonymise(u.id, u.deletionReason)) done += 1;
  }
  return done;
}
