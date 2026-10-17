import { unprocessable } from '../../common/errors/app-error.js';
import { projectCustomerAccount, safeProject } from '../../integration/customer-admin.bridge.js';
import {
  createCustomerSession,
  forceRotateCustomerSession,
  revokeAllCustomerSessions,
  revokeCustomerSession,
  rotateRefreshToken,
  refreshFailure,
  type RotationResult,
} from '../sessions/session.service.js';
import type { CustomerClient, CustomerSessionRecord, DeviceInfo } from '../sessions/session.types.js';
import { userRepository } from '../users/user.repository.js';
import {
  findForWebLogin,
  findOrCreateByVerifiedPhone,
  findOrCreateFromWebRegistration,
  markVerified,
  setPassword,
  type WebRegistrationPayload,
} from '../users/user.service.js';
import type { UserRecord } from '../users/user.types.js';
import { signAccessToken } from './auth.tokens.js';
import type { OtpChannel } from './otp.model.js';
import {
  requestChallenge,
  resendChallenge,
  verifyChallenge,
  type ChallengeInfo,
  type ChallengeView,
} from './otp.service.js';

/**
 * Client-agnostic customer auth orchestration (OTP ⇄ user ⇄ session ⇄ tokens).
 * Controllers own the wire shapes, cookies and per-client error vocabularies.
 */

export interface IssuedTokens {
  accessToken: string;
  /** Seconds. */
  expiresIn: number;
  /** Plaintext refresh token. */
  refreshToken: string;
  session: CustomerSessionRecord;
}

export async function issueCustomerTokens(
  user: UserRecord,
  client: CustomerClient,
  device: DeviceInfo = {},
): Promise<IssuedTokens> {
  const { session, refreshToken } = await createCustomerSession({ userId: user.id, client, device });
  const { token, expiresIn } = signAccessToken({
    sub: user.id,
    sid: session.publicId,
    cli: client,
    roles: user.roles,
  });
  return { accessToken: token, expiresIn, refreshToken, session };
}

// ---------------------------------------------------------------------------------------------
// Mobile — phone + 6-digit code, no passwords
// ---------------------------------------------------------------------------------------------

export async function requestMobileOtp(input: {
  phone: string;
  intent: 'signup' | 'login';
  channel: OtpChannel;
  ip?: string;
}): Promise<ChallengeInfo> {
  return requestChallenge({
    client: 'mobile',
    intent: input.intent,
    channel: input.channel,
    destination: input.phone,
    ip: input.ip,
  });
}

export async function resendMobileOtp(input: {
  challengeId: string;
  channel?: OtpChannel;
  ip?: string;
}): Promise<{ info: ChallengeInfo; challenge: ChallengeView }> {
  return resendChallenge({ ...input, client: 'mobile' });
}

export async function verifyMobileOtp(input: {
  challengeId: string;
  phone: string;
  code: string;
  device: DeviceInfo;
}): Promise<{ tokens: IssuedTokens; user: UserRecord; isNewAccount: boolean }> {
  const challenge = await verifyChallenge({
    challengeId: input.challengeId,
    code: input.code,
    client: 'mobile',
    destination: input.phone,
  });
  // Phone-only product: an unknown number that proves possession becomes an account (login ≡ signup).
  const { user, isNew } = await findOrCreateByVerifiedPhone(challenge.destination);
  await safeProject('account', () => projectAccount(user));
  const tokens = await issueCustomerTokens(user, 'mobile', input.device);
  return { tokens, user, isNewAccount: isNew };
}

/** Mobile `onboarding.nextStep`: resumed sign-ups land where they left off. */
export function mobileNextStep(
  user: Pick<UserRecord, 'profile' | 'tierChosenAt' | 'kycStatus'>,
): 'intro' | 'tier' | 'kycStart' | 'home' {
  if (!user.profile.fullName) return 'intro';
  if (!user.tierChosenAt) return 'tier';
  if (user.kycStatus === 'none' || user.kycStatus === 'rejected') return 'kycStart';
  return 'home';
}

// ---------------------------------------------------------------------------------------------
// Web — mobile / email / whatsapp, 4-digit code
// ---------------------------------------------------------------------------------------------

export type WebMethod = 'mobile' | 'email' | 'whatsapp';

export function channelForWebMethod(method: WebMethod): OtpChannel {
  return method === 'email' ? 'email' : method === 'whatsapp' ? 'whatsapp' : 'sms';
}

export function webMethodForChannel(channel: OtpChannel): WebMethod {
  return channel === 'email' ? 'email' : channel === 'whatsapp' ? 'whatsapp' : 'mobile';
}

export async function registerWeb(input: {
  registration: WebRegistrationPayload;
  ip?: string;
}): Promise<ChallengeInfo> {
  const { registration } = input;
  const existing = await findForWebLogin(registration.method, registration.identifier);
  return requestChallenge({
    client: 'web',
    intent: 'signup',
    channel: channelForWebMethod(registration.method),
    destination: registration.identifier,
    subject: existing ? { type: 'user', id: existing.id } : undefined,
    // The account is created on successful verification, never before — and if one already
    // exists it is signed in unchanged, so the response is identical either way.
    payload: { registration },
    ip: input.ip,
  });
}

export async function requestWebOtp(input: {
  method: WebMethod;
  identifier: string;
  intent: 'login' | 'signup';
  ip?: string;
}): Promise<ChallengeInfo> {
  const existing = await findForWebLogin(input.method, input.identifier);
  return requestChallenge({
    client: 'web',
    intent: input.intent,
    channel: channelForWebMethod(input.method),
    destination: input.identifier,
    subject: existing ? { type: 'user', id: existing.id } : undefined,
    // Unknown identifier: behave identically (same response, same timing class) but send nothing.
    decoy: !existing,
    ip: input.ip,
  });
}

export async function resendWebOtp(input: {
  challengeId: string;
  ip?: string;
}): Promise<{ info: ChallengeInfo; challenge: ChallengeView }> {
  return resendChallenge({ challengeId: input.challengeId, client: 'web', ip: input.ip });
}

export async function verifyWebOtp(input: {
  challengeId: string;
  code: string;
  device: DeviceInfo;
}): Promise<{ tokens: IssuedTokens; user: UserRecord; isNewAccount: boolean }> {
  const challenge = await verifyChallenge({
    challengeId: input.challengeId,
    code: input.code,
    client: 'web',
  });

  const method = webMethodForChannel(challenge.channel);
  const registration = challenge.payload?.registration as WebRegistrationPayload | undefined;
  let user: UserRecord | null;
  let isNew = false;

  if (challenge.intent === 'signup' && registration) {
    const result = await findOrCreateFromWebRegistration({ ...registration, identifier: challenge.destination });
    user = result.user;
    isNew = result.isNew;
  } else {
    user = await findForWebLogin(method, challenge.destination);
    if (user) user = await markVerified(user, method === 'email' ? { email: true } : { phone: true });
  }
  if (!user) throw unprocessable('We could not complete sign-in.', undefined, 'auth/invalid-credentials');

  await safeProject('account', () => projectAccount(user));
  const tokens = await issueCustomerTokens(user, 'web', input.device);
  return { tokens, user, isNewAccount: isNew };
}

// ---------------------------------------------------------------------------------------------
// Shared: refresh, sign-out, password
// ---------------------------------------------------------------------------------------------

export interface RefreshOutcome {
  accessToken: string;
  expiresIn: number;
  /** Absent under the web grace rule — the cookie set by the winning request stays. */
  refreshToken?: string;
  rotated: boolean;
  user: UserRecord;
  session: CustomerSessionRecord;
}

export async function refreshCustomerTokens(input: {
  refreshToken: string;
  client: CustomerClient;
  device?: Partial<DeviceInfo>;
}): Promise<RefreshOutcome> {
  const rotation: RotationResult = await rotateRefreshToken(input);
  const user = await userRepository.findById(rotation.session.userId.toString());
  if (!user) {
    await revokeCustomerSession(rotation.session.publicId, rotation.session.userId.toString(), 'account_deleted');
    throw refreshFailure(input.client, 'invalid');
  }
  const { token, expiresIn } = signAccessToken({
    sub: user.id,
    sid: rotation.session.publicId,
    cli: input.client,
    roles: user.roles,
  });
  return {
    accessToken: token,
    expiresIn,
    refreshToken: rotation.refreshToken,
    rotated: rotation.rotated,
    user,
    session: rotation.session,
  };
}

function projectAccount(user: UserRecord): Promise<void> {
  return projectCustomerAccount({
    id: user.id,
    name: user.profile?.fullName || user.profile?.displayName || 'Customer',
    email: user.email,
    phone: user.phone,
    org: user.profile?.companyName,
    country: user.profile?.countryCode,
    tier: user.tier,
    kycStatus: user.kycStatus,
  });
}

export async function signOutCustomer(input: {
  userId: string;
  sessionPublicId: string;
  allDevices?: boolean;
}): Promise<void> {
  if (input.allDevices) {
    await revokeAllCustomerSessions(input.userId, { reason: 'sign_out' });
  } else {
    await revokeCustomerSession(input.sessionPublicId, input.userId, 'sign_out');
  }
}

/**
 * Web `POST /auth/password/change`: sets/changes the password, revokes every *other* session and
 * rotates the caller's refresh token (returned so the controller can re-set the cookie).
 */
export async function changeWebPassword(input: {
  userId: string;
  sessionPublicId: string;
  currentPassword?: string;
  newPassword: string;
}): Promise<{ refreshToken?: string }> {
  await setPassword(input.userId, input.newPassword, input.currentPassword);
  await revokeAllCustomerSessions(input.userId, {
    exceptPublicId: input.sessionPublicId,
    reason: 'password_changed',
  });
  const rotated = await forceRotateCustomerSession(input.sessionPublicId);
  return { refreshToken: rotated?.refreshToken };
}
