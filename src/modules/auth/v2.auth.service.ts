import { conflict, forbidden, unauthorized, unprocessable } from '../../common/errors/app-error.js';
import { normalizeEmail, normalizePhone } from '../../common/utils/phone.js';
import { references } from '../../common/utils/references.js';
import { enqueueOutbox } from '../outbox/outbox.service.js';
import {
  listActiveCustomerSessions,
  revokeCustomerSession,
} from '../sessions/session.service.js';
import type { CustomerClient, DeviceInfo } from '../sessions/session.types.js';
import { notificationsRepository } from '../notifications/notifications.repository.js';
import { userRepository } from '../users/user.repository.js';
import type {
  BuyerType,
  SellerType,
  UserRecord,
  UserRole,
} from '../users/user.types.js';
import {
  issueCustomerTokens,
  refreshCustomerTokens,
  signOutCustomer,
  type IssuedTokens,
} from './auth.service.js';
import type { OtpChannel, OtpIntent } from './otp.model.js';
import {
  requestChallenge,
  reserveOtpSendSlot,
  resendChallenge,
  verifyChallenge,
  type ChallengeInfo,
} from './otp.service.js';
import { signRegistrationToken, verifyRegistrationToken } from './v2.registration-token.js';

function assertNotSuspended(user: UserRecord): void {
  if (user.accountStatus === 'suspended') {
    throw forbidden('account/suspended', 'This account is suspended. Contact support.');
  }
  if (user.accountStatus === 'closed') {
    throw forbidden('account/closed', 'This account has been closed.');
  }
}

export function normalizeV2Identifier(
  channel: 'whatsapp' | 'sms' | 'email',
  identifier: string,
): string {
  if (channel === 'email') {
    const email = normalizeEmail(identifier);
    if (!email) {
      throw unprocessable('Invalid email address.', { identifier: 'Invalid email' }, 'auth/invalid-identifier');
    }
    return email;
  }
  const phone = normalizePhone(identifier);
  if (!phone) {
    throw unprocessable(
      'Invalid phone number.',
      { identifier: 'Use E.164 format, e.g. +2348034127790' },
      'auth/invalid-identifier',
    );
  }
  return phone;
}

async function findUserByChannel(
  channel: 'whatsapp' | 'sms' | 'email',
  destination: string,
): Promise<UserRecord | null> {
  if (channel === 'email') return userRepository.findByEmail(destination);
  if (channel === 'whatsapp') {
    return (
      (await userRepository.findByWhatsapp(destination)) ??
      (await userRepository.findByPhoneOrWhatsapp(destination))
    );
  }
  return userRepository.findByPhoneOrWhatsapp(destination);
}

function toInternalIntent(intent: 'signup' | 'signin' | 'contact_change'): OtpIntent {
  if (intent === 'signin') return 'login';
  return intent;
}

export async function v2RequestOtp(input: {
  client: CustomerClient;
  intent: 'signup' | 'signin' | 'contact_change';
  channel: 'whatsapp' | 'sms' | 'email';
  identifier: string;
  fullName?: string;
  ip?: string;
  /** When set, contact_change is bound to this user. */
  userId?: string;
}): Promise<ChallengeInfo> {
  const destination = normalizeV2Identifier(input.channel, input.identifier);
  const existing = await findUserByChannel(input.channel, destination);

  if (input.intent === 'signup' && existing) {
    await reserveOtpSendSlot({ client: input.client, destination, ip: input.ip });
    throw conflict('auth/already-registered', 'An account already uses this identifier. Sign in instead.');
  }

  // Sign-in with unknown identifier: decoy 202 (no send) — anti-enumeration.
  if (input.intent === 'signin' && !existing) {
    return requestChallenge({
      client: input.client,
      intent: 'login',
      channel: input.channel as OtpChannel,
      destination,
      decoy: true,
      ip: input.ip,
      payload: { v2: true },
    });
  }

  if (input.intent === 'contact_change') {
    if (!input.userId) {
      throw unauthorized('auth/token-invalid', 'Authentication required');
    }
    if (existing && existing.id !== input.userId) {
      throw conflict('account/contact-in-use', 'That contact is already used by another account.');
    }
  }

  return requestChallenge({
    client: input.client,
    intent: toInternalIntent(input.intent),
    channel: input.channel as OtpChannel,
    destination,
    subject: existing ? { type: 'user', id: existing.id } : input.userId ? { type: 'user', id: input.userId } : undefined,
    ip: input.ip,
    payload: {
      v2: true,
      fullName: input.fullName,
      wireIntent: input.intent,
    },
  });
}

export async function v2ResendOtp(input: {
  client: CustomerClient;
  challengeId: string;
  channel?: 'whatsapp' | 'sms' | 'email';
  ip?: string;
}): Promise<ChallengeInfo> {
  const { info } = await resendChallenge({
    client: input.client,
    challengeId: input.challengeId,
    channel: input.channel as OtpChannel | undefined,
    ip: input.ip,
  });
  return info;
}

export type V2VerifyResult =
  | { status: 'signed_in'; tokens: IssuedTokens; user: UserRecord }
  | { status: 'needs_registration'; registrationToken: string; expiresIn: number };

export async function v2VerifyOtp(input: {
  client: CustomerClient;
  challengeId: string;
  code: string;
  keepSignedIn?: boolean;
  device?: DeviceInfo;
}): Promise<V2VerifyResult> {
  const challenge = await verifyChallenge({
    client: input.client,
    challengeId: input.challengeId,
    code: input.code,
  });

  const wireIntent = (challenge.payload?.wireIntent as string | undefined) ?? challenge.intent;
  const channel = challenge.channel as 'whatsapp' | 'sms' | 'email';
  const destination = challenge.destination;

  if (wireIntent === 'contact_change') {
    // Handled by ME-04; verify alone is not enough without auth context.
    throw unprocessable('Use contact-change/verify for this challenge.', undefined, 'auth/wrong-flow');
  }

  const existing = await findUserByChannel(channel, destination);

  if (existing) {
    assertNotSuspended(existing);
    const $set: Record<string, Date> = { lastLoginAt: new Date() };
    if (channel === 'email' && !existing.emailVerifiedAt) $set.emailVerifiedAt = new Date();
    if (channel === 'sms' && !existing.phoneVerifiedAt) $set.phoneVerifiedAt = new Date();
    if (channel === 'whatsapp' && !existing.whatsappVerifiedAt) $set.whatsappVerifiedAt = new Date();
    const user = (await userRepository.update(existing.id, { $set })) ?? existing;
    const tokens = await issueCustomerTokens(user, input.client, input.device ?? {}, {
      persistent: input.keepSignedIn !== false,
    });
    void enqueueOutbox('audit.customer', {
      action: 'Customer signed in',
      actorId: user.id,
      client: input.client,
    });
    return { status: 'signed_in', tokens, user };
  }

  // New identifier after successful OTP → registration token.
  const { token, expiresIn } = signRegistrationToken({
    dest: destination,
    channel,
    cli: input.client,
    fullName: typeof challenge.payload?.fullName === 'string' ? challenge.payload.fullName : undefined,
  });
  return { status: 'needs_registration', registrationToken: token, expiresIn };
}

export async function v2Register(input: {
  client: CustomerClient;
  registrationToken: string;
  fullName: string;
  role: 'buyer' | 'seller' | 'both';
  buyerType?: BuyerType;
  sellerType?: SellerType;
  businessName?: string;
  countryCode: string;
  termsVersion: string;
  device?: DeviceInfo;
  keepSignedIn?: boolean;
}): Promise<{ tokens: IssuedTokens; user: UserRecord }> {
  const verified = verifyRegistrationToken(input.registrationToken);
  if (!verified.ok || verified.claims.cli !== input.client) {
    throw unauthorized('auth/registration-token-invalid', 'Registration token is invalid or expired.');
  }
  const { dest, channel } = verified.claims;

  const already = await findUserByChannel(channel, dest);
  if (already) throw conflict('auth/already-registered', 'An account already uses this identifier.');

  const customerNo = await references.customerNo();
  const roles: UserRole[] = [input.role];
  const isBusiness = Boolean(input.businessName);
  const createInput = {
    ...(channel === 'email'
      ? { email: dest, emailVerified: true }
      : channel === 'whatsapp'
        ? { phone: dest, phoneVerified: true }
        : { phone: dest, phoneVerified: true }),
    roles,
    profile: {
      fullName: input.fullName,
      countryCode: input.countryCode,
      ...(input.businessName ? { companyName: input.businessName } : {}),
    },
    acceptedTerms: { version: input.termsVersion },
  };

  let user = await userRepository.create(createInput);
  const patch: Record<string, unknown> = {
    customerNo,
    accountStatus: 'active',
    kycStatus: 'none',
    signInMethod: channel === 'email' ? 'email' : channel === 'whatsapp' ? 'whatsapp' : 'sms',
    business: {
      ...(input.buyerType ? { buyerType: input.buyerType } : {}),
      ...(input.sellerType ? { sellerType: input.sellerType } : {}),
      ...(input.businessName ? { name: input.businessName } : {}),
    },
  };
  if (channel === 'whatsapp') {
    patch.whatsapp = dest;
    patch.whatsappVerifiedAt = new Date();
  }
  user = (await userRepository.update(user.id, { $set: patch })) ?? user;

  // Default notification prefs: channel used = on
  await notificationsRepository.updatePrefs(user.id, {
    email: channel === 'email',
    sms: channel === 'sms',
    whatsapp: channel === 'whatsapp',
    push: true,
  });

  void enqueueOutbox('customer.registered', {
    userId: user.id,
    customerNo,
    role: input.role,
    isBusiness,
  });
  void enqueueOutbox('audit.customer', {
    action: 'Customer registered',
    actorId: user.id,
  });

  const tokens = await issueCustomerTokens(user, input.client, input.device ?? {}, {
    persistent: input.keepSignedIn !== false,
  });
  return { tokens, user };
}

export async function v2Refresh(input: {
  client: CustomerClient;
  refreshToken: string;
  device?: Partial<DeviceInfo>;
}): Promise<{ accessToken: string; expiresIn: number; refreshToken?: string; user: UserRecord }> {
  const outcome = await refreshCustomerTokens(input);
  assertNotSuspended(outcome.user);
  return {
    accessToken: outcome.accessToken,
    expiresIn: outcome.expiresIn,
    refreshToken: outcome.refreshToken,
    user: outcome.user,
  };
}

export async function v2Logout(input: {
  userId: string;
  sessionPublicId: string;
}): Promise<void> {
  await signOutCustomer(input);
}

export async function v2ListSessions(input: {
  userId: string;
  currentSessionId: string;
  client: CustomerClient;
}): Promise<Array<{ id: string; client: string; device: string; lastUsedAt: string; current: boolean }>> {
  const sessions = await listActiveCustomerSessions(input.userId);
  return sessions
    .filter((s) => s.client === input.client || true)
    .map((s) => ({
      id: s.publicId,
      client: s.client,
      device: s.device?.name || s.device?.platform || 'Unknown device',
      lastUsedAt: (s.lastUsedAt ?? s.createdAt).toISOString(),
      current: s.publicId === input.currentSessionId,
    }));
}

export async function v2RevokeSession(input: {
  userId: string;
  sessionId: string;
}): Promise<void> {
  await revokeCustomerSession(input.sessionId, input.userId, 'sign_out');
}

/** Wire `Me` object (doc 07). */
export function toMeDto(user: UserRecord, prefs?: { email?: boolean; sms?: boolean; whatsapp?: boolean; push?: boolean }) {
  const role = user.roles.includes('both')
    ? 'both'
    : user.roles.includes('buyer')
      ? 'buyer'
      : user.roles.includes('seller')
        ? 'seller'
        : 'both';
  return {
    id: user.id,
    customerNo: user.customerNo ?? null,
    fullName: user.profile.fullName ?? null,
    email: user.email ?? null,
    phone: user.phone ?? null,
    whatsapp: user.whatsapp ?? null,
    countryCode: user.profile.countryCode ?? null,
    role,
    business: {
      name: user.business?.name ?? user.profile.companyName ?? null,
      buyerType: user.business?.buyerType ?? null,
      sellerType: user.business?.sellerType ?? null,
      isBusiness: Boolean(user.business?.name || user.profile.companyName),
    },
    kyc: {
      status: user.kycStatus,
      reference: user.kycReference ?? null,
      flags: {} as Record<string, string>,
    },
    accountStatus: user.accountStatus,
    notificationPreferences: prefs ?? { email: true, sms: true, whatsapp: true, push: true },
    createdAt: user.createdAt.toISOString(),
  };
}
