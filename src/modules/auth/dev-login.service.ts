import { createHash, timingSafeEqual } from 'node:crypto';
import mongoose from 'mongoose';
import { conflict, forbidden, notFound, tooMany, unauthorized } from '../../common/errors/app-error.js';
import { generateOpaqueToken, generateOtpDigits, hashToken } from '../../common/utils/crypto.js';
import { opaqueId } from '../../common/utils/ids.js';
import { logger } from '../../config/logger.js';
import { createStaffSession, type IssuedStaffSession } from '../sessions/session.service.js';
import type { DeviceInfo } from '../sessions/session.types.js';
import { createStaff, findStaffByEmail, findStaffById, recordStaffLogin } from '../staff/staff.service.js';
import { StaffModel } from '../staff/staff.model.js';
import type { Permissions, StaffRecord, StaffRoleRef } from '../staff/staff.types.js';
import { userRepository, isDuplicateKeyError } from '../users/user.repository.js';
import { UserModel } from '../users/user.model.js';
import type { UserRecord } from '../users/user.types.js';
import { issueCustomerTokens, type IssuedTokens } from './auth.service.js';
import {
  DEV_LOGIN_CODE_LENGTH,
  isAcceptableDevOtp,
  isAudienceEnabled,
  type DevLoginConfig,
  type DevLoginSecret,
} from './dev-login.config.js';
import {
  DEV_LOGIN_ATTEMPT_WINDOW_MS,
  DevLoginAttemptModel,
  DevelopmentPrincipalModel,
  type DevLoginAudience,
} from './dev-login.model.js';
import { OtpChallengeModel, type OtpClient } from './otp.model.js';
import { hashOtpCode, otpFailureToAppError, verifyChallenge, OtpFailure, getChallenge } from './otp.service.js';

const DEV_STAFF_ROLE: StaffRoleRef = {
  id: 'ROLE-DEV',
  name: 'Development operator',
  scope: 'Local development only',
};

const ACCOUNT_CONFLICT = 'Development login cannot use an existing account.';

export interface DevelopmentChallenge {
  challengeId: string;
  expiresIn: number;
  expiresAt: string;
  codeLength: number;
  developmentOtp: string;
}

function sameSecret(given: string, expected: string): boolean {
  const left = createHash('sha256').update(`dev-login:${given}`).digest();
  const right = createHash('sha256').update(`dev-login:${expected}`).digest();
  return timingSafeEqual(left, right);
}

function disabled(config: DevLoginConfig, audience: DevLoginAudience): never {
  if (config.nodeEnv === 'development' && config.enabled && config.misconfigured) {
    logger.warn({ audience, reason: config.misconfigured }, 'Development login configuration was rejected');
  }
  throw notFound('auth/dev-login-disabled', 'Development login is not available.');
}

function requireSecret(config: DevLoginConfig, audience: DevLoginAudience): DevLoginSecret & { permissions?: Permissions } {
  if (!isAudienceEnabled(config, audience)) disabled(config, audience);
  const secret = audience === 'app' ? config.app : config.admin;
  if (!secret) disabled(config, audience);
  return secret;
}

function clientMatches(audience: DevLoginAudience, client: OtpClient): boolean {
  return audience === 'admin' ? client === 'admin' : client === 'web' || client === 'mobile';
}

function generatedCode(): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generateOtpDigits(DEV_LOGIN_CODE_LENGTH);
    if (isAcceptableDevOtp(code)) return code;
  }
  throw notFound('auth/dev-login-disabled', 'Development login is not available.');
}

async function assertCredentialBudget(input: {
  audience: DevLoginAudience;
  ip: string | undefined;
  limit: number;
  now: Date;
  password: string;
  expectedPassword: string;
}): Promise<string> {
  const key = hashToken(`dev-login:${input.audience}:${input.ip ?? 'none'}`);
  const count = await DevLoginAttemptModel.countDocuments({
    key,
    at: { $gte: new Date(input.now.getTime() - DEV_LOGIN_ATTEMPT_WINDOW_MS) },
  });
  if (count >= input.limit) {
    sameSecret(input.password, input.expectedPassword);
    throw tooMany('auth/dev-login-rate-limited', 'Too many attempts. Try again shortly.', 60);
  }
  return key;
}

async function isDevelopmentBuyer(email: string): Promise<UserRecord | null> {
  const identity = await DevelopmentPrincipalModel.findOne({ audience: 'app', email }).lean();
  if (!identity || identity.subjectType !== 'user') return null;
  const user = await userRepository.findById(identity.subjectId);
  if (!user || user.email !== email || user.roles.length !== 1 || user.roles[0] !== 'buyer') {
    throw conflict('auth/dev-login-conflict', ACCOUNT_CONFLICT);
  }
  return user;
}

async function assertAppAvailable(email: string): Promise<void> {
  if (await isDevelopmentBuyer(email)) return;
  const taken = await UserModel.findOne({ email }).select('_id').lean();
  if (taken) throw conflict('auth/dev-login-conflict', ACCOUNT_CONFLICT);
}

async function ensureAppPrincipal(email: string): Promise<UserRecord> {
  const existing = await isDevelopmentBuyer(email);
  if (existing) return existing;
  const taken = await UserModel.findOne({ email }).select('_id').lean();
  if (taken) throw conflict('auth/dev-login-conflict', ACCOUNT_CONFLICT);

  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const now = new Date();
    const created = await UserModel.create(
      [
        {
          email,
          emailVerifiedAt: now,
          roles: ['buyer'],
          profile: { fullName: 'Development operator', countryCode: 'NG' },
          kycStatus: 'none',
          tier: 1,
          lastLoginAt: now,
        },
      ],
      { session },
    );
    const userId = created[0]!._id.toString();
    await DevelopmentPrincipalModel.create(
      [{ audience: 'app', email, subjectType: 'user', subjectId: userId }],
      { session },
    );
    await session.commitTransaction();
    const user = await userRepository.findById(userId);
    if (!user) throw conflict('auth/dev-login-conflict', ACCOUNT_CONFLICT);
    return user;
  } catch (err) {
    await session.abortTransaction().catch(() => undefined);
    if (isDuplicateKeyError(err)) {
      const winner = await isDevelopmentBuyer(email);
      if (winner) return winner;
      throw conflict('auth/dev-login-conflict', ACCOUNT_CONFLICT);
    }
    throw err;
  } finally {
    session.endSession();
  }
}

async function assertAdminAvailable(email: string): Promise<void> {
  const identity = await DevelopmentPrincipalModel.findOne({ audience: 'admin', email }).lean();
  if (identity) {
    const staff = await findStaffById(identity.subjectId);
    if (!staff || staff.email !== email) throw conflict('auth/dev-login-conflict', ACCOUNT_CONFLICT);
    if (staff.disabled) throw forbidden('auth/account-disabled', 'This account has been disabled.');
    return;
  }
  if (await findStaffByEmail(email)) throw conflict('auth/dev-login-conflict', ACCOUNT_CONFLICT);
}

async function ensureAdminPrincipal(email: string, permissions: Permissions): Promise<StaffRecord> {
  const identity = await DevelopmentPrincipalModel.findOne({ audience: 'admin', email }).lean();
  let staffId = identity?.subjectId;
  if (!identity) {
    if (await findStaffByEmail(email)) throw conflict('auth/dev-login-conflict', ACCOUNT_CONFLICT);
    const created = await createStaff({
      email,
      password: `Aa1!${generateOpaqueToken(24)}`,
      name: 'Development operator',
      desk: 'Development',
      role: DEV_STAFF_ROLE,
      permissions,
    });
    try {
      await DevelopmentPrincipalModel.create({
        audience: 'admin',
        email,
        subjectType: 'staff',
        subjectId: created.id,
      });
    } catch (err) {
      const saved = await DevelopmentPrincipalModel.findOne({ audience: 'admin', email }).lean();
      if (!saved || saved.subjectId !== created.id) {
        await StaffModel.deleteOne({ _id: created.id });
      }
      if (isDuplicateKeyError(err) && saved) staffId = saved.subjectId;
      else throw err;
    }
    staffId = staffId ?? created.id;
  }
  if (!staffId) throw conflict('auth/dev-login-conflict', ACCOUNT_CONFLICT);
  const staff = await findStaffById(staffId);
  if (!staff || staff.email !== email) throw conflict('auth/dev-login-conflict', ACCOUNT_CONFLICT);
  if (staff.disabled) throw forbidden('auth/account-disabled', 'This account has been disabled.');
  await StaffModel.updateOne({ _id: staff.id }, { $set: { permissions, role: DEV_STAFF_ROLE } });
  const refreshed = await findStaffById(staff.id);
  if (!refreshed) throw conflict('auth/dev-login-conflict', ACCOUNT_CONFLICT);
  return refreshed;
}

export async function startDevelopmentLogin(input: {
  config: DevLoginConfig;
  audience: DevLoginAudience;
  client: OtpClient;
  email: string;
  password: string;
  ip?: string;
  now?: Date;
}): Promise<DevelopmentChallenge> {
  const secret = requireSecret(input.config, input.audience);
  if (!clientMatches(input.audience, input.client)) disabled(input.config, input.audience);
  const now = input.now ?? new Date();
  const email = input.email.trim().toLowerCase();
  const attemptKey = await assertCredentialBudget({
    audience: input.audience,
    ip: input.ip,
    limit: input.config.maxCredentialAttempts,
    now,
    password: input.password,
    expectedPassword: secret.password,
  });
  const emailOk = sameSecret(email, secret.email);
  const passwordOk = sameSecret(input.password, secret.password);
  if (!emailOk || !passwordOk) {
    await DevLoginAttemptModel.create({ key: attemptKey, at: now });
    logger.warn({ audience: input.audience, client: input.client }, 'Development login credentials rejected');
    throw unauthorized('auth/invalid-credentials', 'Incorrect email or password.');
  }

  if (input.audience === 'app') await assertAppAvailable(secret.email);
  else await assertAdminAvailable(secret.email);

  const code = secret.otp ?? generatedCode();
  const challengeId = opaqueId('chl');
  const expiresAt = new Date(now.getTime() + input.config.ttlSeconds * 1000);
  await OtpChallengeModel.updateMany(
    { client: input.client, intent: 'dev_login', destination: secret.email, consumedAt: null },
    { $set: { consumedAt: now } },
  );
  await OtpChallengeModel.create({
    challengeId,
    client: input.client,
    intent: 'dev_login',
    channel: 'email',
    destination: secret.email,
    maskedDestination: 'development login',
    codeHash: hashOtpCode(challengeId, code),
    codeLength: DEV_LOGIN_CODE_LENGTH,
    expiresAt,
    attempts: 0,
    maxAttempts: input.config.maxOtpAttempts,
    sendCount: 1,
    lastSentAt: now,
    resendAvailableAt: expiresAt,
    decoy: false,
    payload: { developmentLogin: true, audience: input.audience },
    purgeAt: new Date(expiresAt.getTime() + 60 * 60 * 1000),
    createdAt: now,
    updatedAt: now,
  });
  logger.info({ audience: input.audience, client: input.client, challengeId }, 'Development login challenge created');
  return {
    challengeId,
    expiresIn: input.config.ttlSeconds,
    expiresAt: expiresAt.toISOString(),
    codeLength: DEV_LOGIN_CODE_LENGTH,
    developmentOtp: code,
  };
}

async function consumeDevelopmentChallenge(input: {
  config: DevLoginConfig;
  audience: DevLoginAudience;
  client: OtpClient;
  challengeId: string;
  code: string;
  now?: Date;
}): Promise<string> {
  const secret = requireSecret(input.config, input.audience);
  if (!clientMatches(input.audience, input.client)) disabled(input.config, input.audience);
  const existing = await getChallenge(input.challengeId, input.client);
  const audienceOk = existing?.payload?.audience === input.audience && existing.payload?.developmentLogin === true;
  if (!existing || existing.intent !== 'dev_login' || !audienceOk || existing.destination !== secret.email) {
    throw otpFailureToAppError(input.client, new OtpFailure('not_found'));
  }
  await verifyChallenge({
    challengeId: input.challengeId,
    code: input.code,
    client: input.client,
    now: input.now,
    allowDevelopment: true,
  });
  return secret.email;
}

export async function verifyAppDevelopmentLogin(input: {
  config: DevLoginConfig;
  client: 'web' | 'mobile';
  challengeId: string;
  code: string;
  device?: DeviceInfo;
  rememberDevice?: boolean;
  now?: Date;
}): Promise<{ user: UserRecord; tokens: IssuedTokens }> {
  const email = await consumeDevelopmentChallenge({ ...input, audience: 'app' });
  const user = await ensureAppPrincipal(email);
  const tokens = await issueCustomerTokens(user, input.client, input.device ?? {}, {
    persistent: input.rememberDevice !== false,
  });
  return { user, tokens };
}

export async function verifyAdminDevelopmentLogin(input: {
  config: DevLoginConfig;
  challengeId: string;
  code: string;
  device?: DeviceInfo;
  now?: Date;
}): Promise<{ staff: StaffRecord; issued: IssuedStaffSession }> {
  const email = await consumeDevelopmentChallenge({ ...input, audience: 'admin', client: 'admin' });
  const permissions = input.config.admin?.permissions;
  if (!permissions) disabled(input.config, 'admin');
  const staff = await ensureAdminPrincipal(email, permissions);
  const issued = await createStaffSession({ staffId: staff.id, device: input.device });
  await recordStaffLogin(staff.id);
  return { staff, issued };
}

export function developmentLoginStatus(
  config: DevLoginConfig,
  audience: DevLoginAudience,
): { enabled: boolean; codeLength?: number } {
  if (!isAudienceEnabled(config, audience)) return { enabled: false };
  return { enabled: true, codeLength: DEV_LOGIN_CODE_LENGTH };
}
