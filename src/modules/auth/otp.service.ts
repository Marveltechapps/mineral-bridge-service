import { createHmac } from 'node:crypto';
import { AppError } from '../../common/errors/app-error.js';
import { generateOpaqueToken, generateOtpDigits, hashToken, safeEqual } from '../../common/utils/crypto.js';
import { opaqueId } from '../../common/utils/ids.js';
import { maskEmail, maskPhone } from '../../common/utils/phone.js';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { getEmailProvider } from '../../integrations/email/email.provider.js';
import { getOtpProvider } from '../../integrations/otp/otp.provider.js';
import {
  OTP_THROTTLE_WINDOW_MS,
  OtpChallengeModel,
  OtpSendLogModel,
  type OtpChallengeRecord,
  type OtpChallengeShape,
  type OtpChannel,
  type OtpClient,
  type OtpIntent,
} from './otp.model.js';

// =============================================================================================
// Policy
// =============================================================================================

export interface OtpPolicy {
  codeLength: number;
  ttlSeconds: number;
  resendCooldownSeconds: number;
  maxAttempts: number;
  maxPerDestinationPerWindow: number;
  maxPerIpPerWindow: number;
  allowedChannels: readonly OtpChannel[];
}

/**
 * Per-client OTP rules (W-9: lengths differ, so challenges are never shared):
 *  - mobile: 6 digits, 60 s window (`OTP_TTL_SECONDS`), resend countdown 42 s
 *  - web:    4 digits (contract: fixed, "changing it is a breaking change"), 5 min window
 *  - admin:  6 digits, 5 min challenge
 */
export function otpPolicy(client: OtpClient): OtpPolicy {
  const env = loadEnv();
  switch (client) {
    case 'mobile':
      return {
        codeLength: 6,
        ttlSeconds: env.OTP_TTL_SECONDS,
        resendCooldownSeconds: 42,
        maxAttempts: env.OTP_MAX_ATTEMPTS,
        maxPerDestinationPerWindow: env.OTP_MAX_PER_PHONE_15MIN,
        maxPerIpPerWindow: env.OTP_MAX_PER_IP_15MIN,
        allowedChannels: ['sms', 'voice', 'whatsapp'],
      };
    case 'web':
      return {
        codeLength: 4,
        ttlSeconds: 300,
        resendCooldownSeconds: 30,
        maxAttempts: env.OTP_MAX_ATTEMPTS,
        maxPerDestinationPerWindow: env.OTP_MAX_PER_PHONE_15MIN,
        maxPerIpPerWindow: env.OTP_MAX_PER_IP_15MIN,
        allowedChannels: ['sms', 'whatsapp', 'email'],
      };
    case 'admin':
      return {
        codeLength: 6,
        ttlSeconds: 300,
        resendCooldownSeconds: 30,
        maxAttempts: env.OTP_MAX_ATTEMPTS,
        maxPerDestinationPerWindow: Math.max(env.OTP_MAX_PER_PHONE_15MIN, 10),
        maxPerIpPerWindow: Math.max(env.OTP_MAX_PER_IP_15MIN, 20),
        allowedChannels: ['sms', 'email'],
      };
  }
}

// =============================================================================================
// Hashing (pure)
// =============================================================================================

/**
 * HMAC-SHA256 keyed with a server secret and bound to the challenge id. A bare hash of a 4-6
 * digit code can be reversed from a database dump in microseconds; the key makes a dump alone
 * insufficient, and the challenge id stops a hash being reused on another challenge.
 */
export function hashOtpCode(challengeId: string, code: string, secret = loadEnv().JWT_REFRESH_SECRET): string {
  return createHmac('sha256', secret).update(`otp:${challengeId}:${code}`).digest('hex');
}

export function verifyOtpCode(
  challengeId: string,
  code: string,
  expectedHash: string,
  secret = loadEnv().JWT_REFRESH_SECRET,
): boolean {
  if (!/^\d{4,8}$/.test(code)) return false;
  return safeEqual(hashOtpCode(challengeId, code, secret), expectedHash);
}

/** Pure: has this many sends in the window hit the limit? (`count` includes the current attempt.) */
export function isThrottled(countInWindow: number, limit: number): boolean {
  return countInWindow > limit;
}

// =============================================================================================
// Failures -> per-client AppError
// =============================================================================================

export type OtpFailureReason =
  | 'invalid'
  | 'expired'
  | 'attempts_exceeded'
  | 'throttled'
  | 'cooldown'
  | 'not_found';

export class OtpFailure extends Error {
  constructor(
    readonly reason: OtpFailureReason,
    readonly opts: { retryAfterSeconds?: number; attemptsLeft?: number } = {},
  ) {
    super(`otp:${reason}`);
    this.name = 'OtpFailure';
  }
}

/** Mobile s4.3, web s3 and admin s4 each name these differently; this is the single mapping. */
export function otpFailureToAppError(client: OtpClient, failure: OtpFailure): AppError {
  const { reason, opts } = failure;
  const retry = opts.retryAfterSeconds;
  const rateDetails = retry != null ? { retryAfterSeconds: retry } : undefined;

  if (client === 'mobile') {
    switch (reason) {
      case 'invalid':
        return new AppError({ status: 422, code: 'auth/otp-invalid', message: 'That code is incorrect.', fields: { code: 'Incorrect code' }, details: opts.attemptsLeft != null ? { attemptsLeft: opts.attemptsLeft } : undefined });
      case 'expired':
      case 'not_found':
        return new AppError({ status: 410, code: 'auth/otp-expired', message: 'That code has expired. Request a new one.' });
      case 'attempts_exceeded':
        return new AppError({ status: 429, code: 'auth/otp-attempts-exceeded', message: 'Too many incorrect codes. Request a new code.' });
      case 'throttled':
      case 'cooldown':
        return new AppError({ status: 429, code: 'auth/otp-rate-limited', message: 'Too many code requests. Try again shortly.', details: rateDetails });
    }
  }

  if (client === 'web') {
    switch (reason) {
      case 'invalid':
        return new AppError({ status: 422, code: 'auth/otp-incorrect', message: 'That code is incorrect.', fields: { code: 'Incorrect code' }, details: opts.attemptsLeft != null ? { attemptsLeft: opts.attemptsLeft } : undefined });
      case 'expired':
      case 'attempts_exceeded': // "5 wrong codes invalidates the challenge -> auth/otp-expired"
        return new AppError({ status: 401, code: 'auth/otp-expired', message: 'That code has expired. Request a new one.' });
      case 'not_found':
        return new AppError({ status: 401, code: 'auth/invalid-credentials', message: 'We could not verify that request.' });
      case 'throttled':
      case 'cooldown':
        return new AppError({ status: 429, code: 'auth/otp-throttled', message: 'Too many code requests. Try again shortly.', details: rateDetails });
    }
  }

  switch (reason) {
    case 'invalid':
      return new AppError({ status: 401, code: 'auth/invalid-otp', message: 'That code is incorrect.', details: { attemptsLeft: opts.attemptsLeft ?? 0 } });
    case 'expired':
    case 'not_found':
      return new AppError({ status: 410, code: 'auth/challenge-expired', message: 'That code has expired. Sign in again.' });
    case 'attempts_exceeded':
      return new AppError({ status: 423, code: 'auth/challenge-locked', message: 'Too many incorrect codes. Sign in again.' });
    case 'throttled':
    case 'cooldown':
      return new AppError({ status: 429, code: 'rate-limited', message: 'Too many code requests. Try again shortly.', details: rateDetails });
  }
}

function fail(client: OtpClient, reason: OtpFailureReason, opts: ConstructorParameters<typeof OtpFailure>[1] = {}): AppError {
  return otpFailureToAppError(client, new OtpFailure(reason, opts));
}

// =============================================================================================
// Service
// =============================================================================================

type LeanChallenge = OtpChallengeShape & { _id: { toString(): string } };

/** A challenge as seen outside this module — never carries the code hash. */
export type ChallengeView = Omit<OtpChallengeRecord, 'codeHash'>;

function toRecord(raw: LeanChallenge | null): (ChallengeView & { codeHash?: string }) | null {
  if (!raw) return null;
  const { _id, ...rest } = raw as LeanChallenge & Record<string, unknown>;
  return { ...(rest as unknown as Omit<OtpChallengeShape, 'codeHash'> & { codeHash?: string }), id: _id.toString() };
}

export interface ChallengeInfo {
  challengeId: string;
  client: OtpClient;
  intent: OtpIntent;
  channel: OtpChannel;
  maskedDestination: string;
  codeLength: number;
  expiresAt: Date;
  expiresInSeconds: number;
  resendAfterSeconds: number;
  resendAvailableAt: Date;
}

function toInfo(c: Omit<OtpChallengeShape, 'codeHash'>, now: Date): ChallengeInfo {
  return {
    challengeId: c.challengeId,
    client: c.client,
    intent: c.intent,
    channel: c.channel,
    maskedDestination: c.maskedDestination,
    codeLength: c.codeLength,
    expiresAt: c.expiresAt,
    expiresInSeconds: Math.max(0, Math.ceil((c.expiresAt.getTime() - now.getTime()) / 1000)),
    resendAfterSeconds: Math.max(0, Math.ceil((c.resendAvailableAt.getTime() - now.getTime()) / 1000)),
    resendAvailableAt: c.resendAvailableAt,
  };
}

function maskFor(channel: OtpChannel, destination: string): string {
  return channel === 'email' ? maskEmail(destination) : maskPhone(destination);
}

async function deliver(
  channel: OtpChannel,
  destination: string,
  code: string,
  ttlSeconds: number,
): Promise<void> {
  if (channel === 'email') {
    await getEmailProvider().send({
      to: destination,
      subject: 'Your Mineral Bridge verification code',
      text: `Your Mineral Bridge verification code is ${code}. It expires in ${Math.ceil(ttlSeconds / 60)} minutes. If you did not request it, ignore this email.`,
    });
    return;
  }
  await getOtpProvider().send({ to: destination, code, channel, ttlSeconds });
}

/** Records this send and enforces both limits (destination + IP). Insert-first so parallel bursts are still counted. */
async function enforceThrottle(
  client: OtpClient,
  destination: string,
  ip: string | undefined,
  policy: OtpPolicy,
  now: Date,
): Promise<void> {
  const windowStart = new Date(now.getTime() - OTP_THROTTLE_WINDOW_MS);
  const destKey = hashToken(`dest:${client}:${destination}`);
  const ipKey = ip ? hashToken(`ip:${client}:${ip}`) : null;

  await OtpSendLogModel.insertMany([
    { key: destKey, kind: 'destination', client, at: now },
    ...(ipKey ? [{ key: ipKey, kind: 'ip' as const, client, at: now }] : []),
  ]);

  const checks: Array<{ key: string; limit: number }> = [
    { key: destKey, limit: policy.maxPerDestinationPerWindow },
  ];
  if (ipKey) checks.push({ key: ipKey, limit: policy.maxPerIpPerWindow });

  for (const { key, limit } of checks) {
    const count = await OtpSendLogModel.countDocuments({ key, at: { $gte: windowStart } });
    if (isThrottled(count, limit)) {
      const oldest = await OtpSendLogModel.findOne({ key, at: { $gte: windowStart } })
        .sort({ at: 1 })
        .lean<{ at: Date }>();
      const retryAfterSeconds = oldest
        ? Math.max(1, Math.ceil((oldest.at.getTime() + OTP_THROTTLE_WINDOW_MS - now.getTime()) / 1000))
        : undefined;
      throw fail(client, 'throttled', { retryAfterSeconds });
    }
  }
}

export interface RequestChallengeInput {
  client: OtpClient;
  intent: OtpIntent;
  channel: OtpChannel;
  destination: string;
  subject?: { type: 'user' | 'staff'; id: string };
  payload?: Record<string, unknown>;
  ip?: string;
  /** Create the challenge but send nothing; verification always fails. */
  decoy?: boolean;
  now?: Date;
}

export async function requestChallenge(input: RequestChallengeInput): Promise<ChallengeInfo> {
  const now = input.now ?? new Date();
  const policy = otpPolicy(input.client);
  if (!policy.allowedChannels.includes(input.channel)) {
    throw new AppError({
      status: 422,
      code: 'validation/failed',
      message: 'That delivery channel is not available.',
      fields: { channel: 'Unsupported channel' },
    });
  }

  await enforceThrottle(input.client, input.destination, input.ip, policy, now);

  const challengeId = opaqueId('chl');
  const code = generateOtpDigits(policy.codeLength);
  const expiresAt = new Date(now.getTime() + policy.ttlSeconds * 1000);
  const shape: OtpChallengeShape = {
    challengeId,
    client: input.client,
    intent: input.intent,
    channel: input.channel,
    destination: input.destination,
    maskedDestination: maskFor(input.channel, input.destination),
    // Decoys store a hash nobody can match.
    codeHash: input.decoy ? hashOtpCode(challengeId, `decoy:${generateOpaqueToken(8)}`) : hashOtpCode(challengeId, code),
    codeLength: policy.codeLength,
    expiresAt,
    attempts: 0,
    maxAttempts: policy.maxAttempts,
    sendCount: 1,
    lastSentAt: now,
    resendAvailableAt: new Date(now.getTime() + policy.resendCooldownSeconds * 1000),
    subjectType: input.subject?.type,
    subjectId: input.subject?.id,
    decoy: Boolean(input.decoy),
    payload: input.payload,
    purgeAt: new Date(expiresAt.getTime() + 60 * 60 * 1000),
    createdAt: now,
    updatedAt: now,
  };
  await OtpChallengeModel.create(shape);

  if (!input.decoy) {
    try {
      await deliver(input.channel, input.destination, code, policy.ttlSeconds);
    } catch (err) {
      await OtpChallengeModel.deleteOne({ challengeId });
      throw err;
    }
  }
  return toInfo(shape, now);
}

export async function getChallenge(challengeId: string, client: OtpClient): Promise<ChallengeView | null> {
  const row = toRecord(await OtpChallengeModel.findOne({ challengeId, client }).lean<LeanChallenge>());
  return row;
}

export async function resendChallenge(input: {
  challengeId: string;
  client: OtpClient;
  channel?: OtpChannel;
  ip?: string;
  now?: Date;
}): Promise<{ info: ChallengeInfo; challenge: ChallengeView }> {
  const now = input.now ?? new Date();
  const policy = otpPolicy(input.client);
  const existing = await getChallenge(input.challengeId, input.client);
  if (!existing || existing.consumedAt) throw fail(input.client, 'not_found');

  const isLocked = Boolean(existing.lockedAt) || existing.attempts >= existing.maxAttempts;
  // Mobile: "5 wrong codes; new code required" => a resend clears the lock.
  // Web/admin: the challenge is dead; the user starts again.
  if (isLocked && input.client !== 'mobile') throw fail(input.client, 'attempts_exceeded');

  if (existing.resendAvailableAt.getTime() > now.getTime()) {
    throw fail(input.client, 'cooldown', {
      retryAfterSeconds: Math.ceil((existing.resendAvailableAt.getTime() - now.getTime()) / 1000),
    });
  }

  const channel = input.channel ?? existing.channel;
  if (!policy.allowedChannels.includes(channel)) {
    throw new AppError({
      status: 422,
      code: 'validation/failed',
      message: 'That delivery channel is not available.',
      fields: { channel: 'Unsupported channel' },
    });
  }
  // Voice/WhatsApp only make sense for phone destinations.
  if (existing.channel === 'email' && channel !== 'email') {
    throw new AppError({
      status: 422,
      code: 'validation/failed',
      message: 'That delivery channel is not available for this destination.',
      fields: { channel: 'Unsupported channel' },
    });
  }

  await enforceThrottle(input.client, existing.destination, input.ip, policy, now);

  const previous = await OtpChallengeModel.findOne({
    challengeId: existing.challengeId,
    client: input.client,
  })
    .select('+codeHash')
    .lean<LeanChallenge>();
  if (!previous) throw fail(input.client, 'not_found');

  const code = generateOtpDigits(policy.codeLength);
  const expiresAt = new Date(now.getTime() + policy.ttlSeconds * 1000);
  const updated = await OtpChallengeModel.findOneAndUpdate(
    {
      challengeId: existing.challengeId,
      consumedAt: null,
      resendAvailableAt: { $lte: now },
    },
    {
      $set: {
        codeHash: existing.decoy
          ? hashOtpCode(existing.challengeId, `decoy:${generateOpaqueToken(8)}`)
          : hashOtpCode(existing.challengeId, code),
        channel,
        expiresAt,
        attempts: 0,
        lastSentAt: now,
        resendAvailableAt: new Date(now.getTime() + policy.resendCooldownSeconds * 1000),
        purgeAt: new Date(expiresAt.getTime() + 60 * 60 * 1000),
      },
      $unset: { lockedAt: 1 },
      $inc: { sendCount: 1 },
    },
    { new: true },
  ).lean<LeanChallenge>();
  if (!updated) throw fail(input.client, 'cooldown', { retryAfterSeconds: policy.resendCooldownSeconds });

  if (!existing.decoy) {
    try {
      await deliver(channel, existing.destination, code, policy.ttlSeconds);
    } catch (err) {
      // The new hash was stored before the provider answered. Put the previous code back
      // so a failed send does not burn the code the person may already have.
      await OtpChallengeModel.updateOne(
        { challengeId: existing.challengeId },
        {
          $set: {
            codeHash: previous.codeHash,
            channel: previous.channel,
            expiresAt: previous.expiresAt,
            attempts: previous.attempts,
            lastSentAt: previous.lastSentAt,
            resendAvailableAt: previous.resendAvailableAt,
            purgeAt: previous.purgeAt,
            sendCount: previous.sendCount,
            ...(previous.lockedAt ? { lockedAt: previous.lockedAt } : {}),
          },
          ...(previous.lockedAt ? {} : { $unset: { lockedAt: 1 as const } }),
        },
      );
      throw err;
    }
  }
  const record = toRecord(updated)!;
  return { info: toInfo(record, now), challenge: record };
}

export interface VerifyChallengeInput {
  challengeId: string;
  code: string;
  client: OtpClient;
  /** Mobile also sends the phone; it must match the challenge or the attempt counts as wrong. */
  destination?: string;
  now?: Date;
}

/**
 * Verifies and consumes a challenge. The attempt counter is incremented *before* the comparison
 * and gated by `attempts < maxAttempts` in the same atomic update, so parallel guesses cannot
 * exceed the limit.
 */
export async function verifyChallenge(input: VerifyChallengeInput): Promise<ChallengeView> {
  const now = input.now ?? new Date();
  const existing = toRecord(
    await OtpChallengeModel.findOne({ challengeId: input.challengeId, client: input.client })
      .select('+codeHash')
      .lean<LeanChallenge>(),
  );
  if (!existing || existing.consumedAt) throw fail(input.client, 'not_found');
  if (existing.expiresAt.getTime() <= now.getTime()) throw fail(input.client, 'expired');
  if (existing.lockedAt || existing.attempts >= existing.maxAttempts) {
    throw fail(input.client, 'attempts_exceeded');
  }

  const bumped = await OtpChallengeModel.findOneAndUpdate(
    {
      challengeId: existing.challengeId,
      consumedAt: null,
      lockedAt: null,
      expiresAt: { $gt: now },
      attempts: { $lt: existing.maxAttempts },
    },
    { $inc: { attempts: 1 } },
    { new: true, projection: { attempts: 1, maxAttempts: 1 } },
  ).lean<{ attempts: number; maxAttempts: number }>();
  if (!bumped) throw fail(input.client, 'attempts_exceeded');

  const destinationOk = !input.destination || safeEqual(input.destination, existing.destination);
  const codeOk =
    !existing.decoy &&
    destinationOk &&
    verifyOtpCode(existing.challengeId, input.code, existing.codeHash ?? '');

  if (codeOk) {
    const consumed = await OtpChallengeModel.updateOne(
      { challengeId: existing.challengeId, consumedAt: null },
      { $set: { consumedAt: now } },
    );
    if (consumed.modifiedCount !== 1) throw fail(input.client, 'not_found');
    const { codeHash: _omit, ...safe } = existing;
    void _omit;
    return { ...safe, attempts: bumped.attempts, consumedAt: now };
  }

  const attemptsLeft = Math.max(0, bumped.maxAttempts - bumped.attempts);
  if (attemptsLeft === 0) {
    await OtpChallengeModel.updateOne({ challengeId: existing.challengeId }, { $set: { lockedAt: now } });
    logger.warn({ challengeId: existing.challengeId, client: input.client }, 'OTP challenge locked');
    throw fail(input.client, 'attempts_exceeded');
  }
  throw fail(input.client, 'invalid', { attemptsLeft });
}
