import { conflict, unauthorized, unprocessable } from '../../common/errors/app-error.js';
import { notificationsRepository } from '../notifications/notifications.repository.js';
import { enqueueOutbox } from '../outbox/outbox.service.js';
import { userRepository } from '../users/user.repository.js';
import type { BuyerType, SellerType, UserRecord, UserRole } from '../users/user.types.js';
import {
  normalizeV2Identifier,
  toMeDto,
  v2RequestOtp,
} from './v2.auth.service.js';
import { verifyChallenge } from './otp.service.js';
import type { CustomerClient } from '../sessions/session.types.js';

export async function getMe(userId: string) {
  const user = await userRepository.findById(userId);
  if (!user) throw unauthorized('auth/token-invalid', 'Authentication required');
  const prefs = await notificationsRepository.prefs(userId);
  return toMeDto(user, {
    email: prefs.email,
    sms: prefs.sms,
    whatsapp: prefs.whatsapp,
    push: prefs.push,
  });
}

export async function patchMe(
  userId: string,
  patch: { fullName?: string; businessName?: string; countryCode?: string },
) {
  const $set: Record<string, unknown> = {};
  if (patch.fullName !== undefined) $set['profile.fullName'] = patch.fullName;
  if (patch.countryCode !== undefined) $set['profile.countryCode'] = patch.countryCode;
  if (patch.businessName !== undefined) {
    $set['business.name'] = patch.businessName;
    $set['profile.companyName'] = patch.businessName;
  }
  const user = await userRepository.update(userId, { $set });
  if (!user) throw unauthorized('auth/token-invalid', 'Authentication required');
  void enqueueOutbox('audit.customer', { action: 'Profile updated', actorId: userId, patch });
  return getMe(userId);
}

export async function startContactChange(input: {
  userId: string;
  client: CustomerClient;
  channel: 'whatsapp' | 'sms' | 'email';
  identifier: string;
  ip?: string;
}) {
  return v2RequestOtp({
    client: input.client,
    intent: 'contact_change',
    channel: input.channel,
    identifier: input.identifier,
    ip: input.ip,
    userId: input.userId,
  });
}

export async function confirmContactChange(input: {
  userId: string;
  client: CustomerClient;
  challengeId: string;
  code: string;
}) {
  const challenge = await verifyChallenge({
    client: input.client,
    challengeId: input.challengeId,
    code: input.code,
  });
  if (challenge.intent !== 'contact_change' && challenge.payload?.wireIntent !== 'contact_change') {
    throw unprocessable('Not a contact-change challenge.', undefined, 'auth/wrong-flow');
  }
  if (challenge.subjectId && challenge.subjectId !== input.userId) {
    throw unauthorized('auth/token-invalid', 'Challenge does not belong to this account.');
  }

  const channel = challenge.channel as 'whatsapp' | 'sms' | 'email';
  const destination = challenge.destination;
  const user = await userRepository.findById(input.userId);
  if (!user) throw unauthorized('auth/token-invalid', 'Authentication required');

  // Ensure at least one contact remains after change (rule from ME-04).
  const next = { ...user };
  if (channel === 'email') next.email = destination;
  if (channel === 'sms') next.phone = destination;
  if (channel === 'whatsapp') next.whatsapp = destination;
  if (!next.email && !next.phone && !next.whatsapp) {
    throw conflict('account/contact-required', 'At least one contact method is required.');
  }

  const other =
    channel === 'email'
      ? await userRepository.findByEmail(destination)
      : await userRepository.findByPhoneOrWhatsapp(destination);
  if (other && other.id !== input.userId) {
    throw conflict('account/contact-in-use', 'That contact is already used by another account.');
  }

  const $set: Record<string, unknown> = {};
  if (channel === 'email') {
    $set.email = destination;
    $set.emailVerifiedAt = new Date();
  } else if (channel === 'whatsapp') {
    $set.whatsapp = destination;
    $set.whatsappVerifiedAt = new Date();
  } else {
    $set.phone = destination;
    $set.phoneVerifiedAt = new Date();
  }

  await userRepository.update(input.userId, { $set });
  void enqueueOutbox('account.contact_changed', {
    userId: input.userId,
    channel,
    oldEmail: user.email,
    oldPhone: user.phone,
  });
  void enqueueOutbox('audit.customer', { action: 'Contact changed', actorId: input.userId });
  return getMe(input.userId);
}

export async function updateBusinessType(
  userId: string,
  input: {
    role: 'buyer' | 'seller' | 'both';
    buyerType?: BuyerType;
    sellerType?: SellerType;
    businessName?: string;
  },
) {
  const roles: UserRole[] = [input.role];
  const $set: Record<string, unknown> = {
    roles,
    'business.buyerType': input.buyerType,
    'business.sellerType': input.sellerType,
  };
  if (input.businessName !== undefined) {
    $set['business.name'] = input.businessName;
    $set['profile.companyName'] = input.businessName;
  }
  await userRepository.update(userId, { $set });
  void enqueueOutbox('audit.customer', { action: 'Account type changed', actorId: userId });
  return getMe(userId);
}

export async function getNotificationPreferences(userId: string) {
  const prefs = await notificationsRepository.prefs(userId);
  return {
    email: prefs.email,
    sms: prefs.sms,
    whatsapp: prefs.whatsapp,
    push: prefs.push,
  };
}

export async function patchNotificationPreferences(
  userId: string,
  patch: { email?: boolean; sms?: boolean; whatsapp?: boolean; push?: boolean },
) {
  const user = await userRepository.findById(userId);
  if (!user) throw unauthorized('auth/token-invalid', 'Authentication required');
  const current = await notificationsRepository.prefs(userId);
  const next = {
    email: patch.email ?? current.email,
    sms: patch.sms ?? current.sms,
    whatsapp: patch.whatsapp ?? current.whatsapp,
    push: patch.push ?? current.push,
  };
  if (!next.email && !next.sms && !next.whatsapp && !next.push) {
    throw unprocessable(
      'Keep at least one notification channel enabled.',
      undefined,
      'preferences/at-least-one-channel',
    );
  }
  if (next.email && !user.email) {
    throw unprocessable('Add an email before enabling email notifications.', undefined, 'preferences/no-destination');
  }
  if ((next.sms || next.whatsapp) && !user.phone && !user.whatsapp) {
    throw unprocessable('Add a phone before enabling SMS/WhatsApp.', undefined, 'preferences/no-destination');
  }
  await notificationsRepository.updatePrefs(userId, next);
  return next;
}

export async function getHomeSummary(userId: string) {
  const user = await userRepository.findById(userId);
  if (!user) throw unauthorized('auth/token-invalid', 'Authentication required');
  const unread = await notificationsRepository.countUnread(userId);
  return {
    actionNeeded: [] as unknown[],
    counts: {
      activeOrders: user.stats?.openOrders ?? 0,
      sellRequests: user.stats?.sells ?? 0,
      actionNeeded: 0,
    },
    unreadNotifications: unread,
    kyc: {
      status: user.kycStatus,
      reference: user.kycReference ?? null,
    },
  };
}

export { normalizeV2Identifier };
export type { UserRecord };
