import { AppError, forbidden, gone, unauthorized, unprocessable } from '../../common/errors/app-error.js';
import { generateOpaqueToken, hashToken } from '../../common/utils/crypto.js';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { getEmailProvider } from '../../integrations/email/email.provider.js';
import {
  createStaffSession,
  lockStaffSession,
  registerUnlockFailure,
  revokeAllStaffSessions,
  staffSessionExpiresAt,
  unlockStaffSession,
  type IssuedStaffSession,
} from '../sessions/session.service.js';
import type { DeviceInfo, StaffSessionRecord } from '../sessions/session.types.js';
import {
  findStaffByEmail,
  findStaffById,
  isStaffEmailDomainAllowed,
  recordStaffLogin,
  setStaffPassword,
  verifyCredentials,
  verifyStaffPassword,
} from '../staff/staff.service.js';
import { PERMISSION_MODULES, type StaffRecord } from '../staff/staff.types.js';
import { initialsOf } from '../users/user.service.js';
import {
  buildSsoRedirectUrl,
  getSsoConfig,
  getSsoProvider,
  sanitizeReturnTo,
  ssoNotConfigured,
  verifySsoState,
} from './admin.sso.js';
import { PasswordResetTokenModel } from './password-reset.model.js';
import {
  requestChallenge,
  resendChallenge,
  verifyChallenge,
  type ChallengeInfo,
} from './otp.service.js';

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// Wire builders (admin §3.3 `Me`)
// ---------------------------------------------------------------------------------------------

export function buildMe(staff: StaffRecord, session: StaffSessionRecord, csrfToken: string) {
  const permissions = Object.fromEntries(
    PERMISSION_MODULES.map((m) => [m, staff.permissions[m] ?? 'none']),
  );
  return {
    id: staff.publicId,
    name: staff.name,
    initials: initialsOf(staff.name),
    email: staff.email,
    phone: staff.phone ?? '',
    desk: staff.desk,
    role: { id: staff.role.id, name: staff.role.name, scope: staff.role.scope },
    permissions,
    session: {
      id: session.publicId,
      state: session.state,
      expiresAt: staffSessionExpiresAt(session).toISOString(),
      ...(session.lockedAt ? { lockedAt: session.lockedAt.toISOString() } : {}),
    },
    csrfToken,
  };
}

export function challengeBody(info: ChallengeInfo) {
  return {
    challengeId: info.challengeId,
    channel: info.channel,
    maskedDestination: info.maskedDestination,
    expiresAt: info.expiresAt.toISOString(),
    resendAvailableAt: info.resendAvailableAt.toISOString(),
    ...(info.developmentOtp ? { developmentOtp: info.developmentOtp } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Sign-in (#1) → challenge (#4) → session
// ---------------------------------------------------------------------------------------------

async function issueStaffChallenge(
  staff: StaffRecord,
  opts: { ip?: string; returnTo?: string },
): Promise<ChallengeInfo> {
  // 2FA goes to the phone on file; staff without one fall back to their work email.
  const channel = staff.phone ? 'sms' : 'email';
  return requestChallenge({
    client: 'admin',
    intent: 'staff_login',
    channel,
    destination: staff.phone ?? staff.email,
    subject: { type: 'staff', id: staff.id },
    payload: { returnTo: sanitizeReturnTo(opts.returnTo) },
    ip: opts.ip,
  });
}

/**
 * Password sign-in checks the staff record and opens the console session.
 * `401 auth/invalid-credentials` never says whether the email exists. A disabled account is only
 * revealed (`403 auth/account-disabled`) after the correct password. OTP verification stays
 * available for challenges that already exist, and does not run as part of this step.
 */
export async function signIn(input: {
  email: string;
  password: string;
  ip?: string;
  returnTo?: string;
  device?: DeviceInfo;
}): Promise<{ issued: IssuedStaffSession; staff: StaffRecord; redirectTo: string }> {
  const staff = await verifyCredentials(input.email, input.password);
  if (!staff) throw unauthorized('auth/invalid-credentials', 'Incorrect email or password.');
  if (staff.disabled) throw forbidden('auth/account-disabled', 'This account has been disabled. Contact your administrator.');
  const issued = await createStaffSession({ staffId: staff.id, device: { ...input.device, ip: input.ip } });
  await recordStaffLogin(staff.id);
  return { issued, staff, redirectTo: sanitizeReturnTo(input.returnTo) };
}

// ---- SSO (#2/#3) ----------------------------------------------------------------------------

export function startSso(input: { email: string; returnTo?: string }): { redirectUrl: string } {
  if (!isStaffEmailDomainAllowed(input.email)) {
    throw unprocessable('Enter a staff email above, then continue with SSO.', undefined, 'rule/not-staff-domain');
  }
  const config = getSsoConfig();
  if (!config) throw ssoNotConfigured();
  return {
    redirectUrl: buildSsoRedirectUrl(config, { email: input.email, returnTo: sanitizeReturnTo(input.returnTo) }),
  };
}

export async function completeSso(input: { code: string; state: string; ip?: string }): Promise<ChallengeInfo> {
  const config = getSsoConfig();
  if (!config) throw ssoNotConfigured();
  const state = verifySsoState(input.state);

  const provider = getSsoProvider();
  if (!provider) {
    throw new AppError({
      status: 503,
      code: 'auth/sso-not-configured',
      message: 'Single sign-on is configured but no identity provider is registered to complete it.',
    });
  }
  const identity = await provider.exchangeCode({ code: input.code, redirectUri: config.redirectUri });
  const staff = await findStaffByEmail(identity.email);
  if (!staff) throw unauthorized('auth/invalid-credentials', 'This account is not registered for the console.');
  if (staff.disabled) throw forbidden('auth/account-disabled', 'This account has been disabled. Contact your administrator.');
  // 2FA is still required after SSO.
  return issueStaffChallenge(staff, { ip: input.ip, returnTo: state.returnTo });
}

// ---- OTP (#4/#5) ----------------------------------------------------------------------------

export async function verifySignInOtp(input: {
  challengeId: string;
  code: string;
  device?: DeviceInfo;
}): Promise<{ issued: IssuedStaffSession; staff: StaffRecord; redirectTo: string }> {
  const challenge = await verifyChallenge({
    challengeId: input.challengeId,
    code: input.code,
    client: 'admin',
  });
  const staff = challenge.subjectId ? await findStaffById(challenge.subjectId) : null;
  if (!staff || challenge.subjectType !== 'staff') {
    throw unauthorized('auth/invalid-credentials', 'Sign in again.');
  }
  if (staff.disabled) throw forbidden('auth/account-disabled', 'This account has been disabled. Contact your administrator.');

  const issued = await createStaffSession({ staffId: staff.id, device: input.device });
  await recordStaffLogin(staff.id);
  return {
    issued,
    staff,
    redirectTo: sanitizeReturnTo(challenge.payload?.returnTo as string | undefined),
  };
}

export async function resendSignInOtp(input: { challengeId: string; ip?: string }): Promise<ChallengeInfo> {
  const { info } = await resendChallenge({ challengeId: input.challengeId, client: 'admin', ip: input.ip });
  return info;
}

// ---------------------------------------------------------------------------------------------
// Password reset (#6/#7)
// ---------------------------------------------------------------------------------------------

/** Prefer the dashboard the staff member is actually using, when that origin is allowed. */
function dashboardBase(requested?: string): string {
  const env = loadEnv();
  const allowed = env.corsAdminOrigins.map((origin) => origin.replace(/\/$/, ''));
  const candidate = requested?.trim().replace(/\/$/, '');
  if (candidate && allowed.includes(candidate)) return candidate;
  return (allowed[0] ?? env.PUBLIC_API_BASE_URL).replace(/\/$/, '');
}

/** Always completes silently — the caller answers `202` for known and unknown emails alike. */
export async function requestPasswordReset(input: { email: string; ip?: string; origin?: string }): Promise<void> {
  const staff = await findStaffByEmail(input.email);
  if (!staff || staff.disabled) return;

  const token = `rst_${generateOpaqueToken(32)}`;
  await PasswordResetTokenModel.create({
    staffId: staff.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
    requestedIp: input.ip,
  });

  const link = `${dashboardBase(input.origin)}/reset-password?token=${encodeURIComponent(token)}`;
  try {
    await getEmailProvider().send({
      to: staff.email,
      subject: 'Reset your Mineral Bridge console password',
      text: `Use this link within 1 hour to choose a new password:\n\n${link}\n\nIf you did not ask for this, you can ignore this email — your password has not changed.`,
    });
  } catch (err) {
    // A mail outage must not turn into an enumeration oracle (unknown email ⇒ 202, known ⇒ 503).
    logger.error({ err }, 'Password reset email failed to send');
  }
}

/** Revokes every session of the staff member on success. */
export async function confirmPasswordReset(input: { token: string; newPassword: string }): Promise<void> {
  const row = await PasswordResetTokenModel.findOne({ tokenHash: hashToken(input.token) });
  if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) {
    throw gone('auth/token-expired', 'This reset link has expired. Request a new one.');
  }
  // Validate (policy + last-5 history) before spending the token, so a weak password can be retried.
  await setStaffPassword(row.staffId.toString(), input.newPassword);

  const claimed = await PasswordResetTokenModel.updateOne(
    { _id: row._id, usedAt: null },
    { $set: { usedAt: new Date() } },
  );
  if (claimed.modifiedCount !== 1) throw gone('auth/token-expired', 'This reset link has expired. Request a new one.');
  await revokeAllStaffSessions(row.staffId.toString(), { reason: 'password_reset' });
}

// ---------------------------------------------------------------------------------------------
// Lock / unlock (#9/#10)
// ---------------------------------------------------------------------------------------------

export async function lockConsole(session: StaffSessionRecord): Promise<Date> {
  const locked = await lockStaffSession(session);
  return locked.lockedAt ?? new Date();
}

/** 5 wrong passwords revoke the session (`401 auth/session-expired`); otherwise `401 auth/invalid-credentials`. */
export async function unlockConsole(input: {
  staff: StaffRecord;
  session: StaffSessionRecord;
  password: string;
}): Promise<StaffSessionRecord> {
  const ok = await verifyStaffPassword(input.staff.id, input.password);
  if (!ok) {
    const { revoked } = await registerUnlockFailure(input.session);
    if (revoked) throw unauthorized('auth/session-expired', 'Too many failed attempts. Sign in again.');
    throw unauthorized('auth/invalid-credentials', 'Incorrect password.');
  }
  return unlockStaffSession(input.session);
}
