import { createHmac } from 'node:crypto';
import { isValidObjectId, Types } from 'mongoose';
import { AppError, unauthorized } from '../../common/errors/app-error.js';
import { generateOpaqueToken, hashToken, safeEqual } from '../../common/utils/crypto.js';
import { IdPrefixes, opaqueId } from '../../common/utils/ids.js';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { CustomerSessionModel, StaffSessionModel } from './session.model.js';
import type {
  CustomerClient,
  CustomerSessionRecord,
  CustomerSessionShape,
  DeviceInfo,
  RevokeReason,
  StaffSessionRecord,
  StaffSessionShape,
} from './session.types.js';

type WithId<T> = T & { _id: { toString(): string } };

function toCustomerRecord(raw: WithId<CustomerSessionShape> | null): CustomerSessionRecord | null {
  if (!raw) return null;
  const { _id, ...rest } = raw as WithId<CustomerSessionShape> & Record<string, unknown>;
  return { ...(rest as unknown as CustomerSessionShape), id: _id.toString() };
}

function toStaffRecord(raw: WithId<StaffSessionShape> | null): StaffSessionRecord | null {
  if (!raw) return null;
  const { _id, ...rest } = raw as WithId<StaffSessionShape> & Record<string, unknown>;
  return { ...(rest as unknown as StaffSessionShape), id: _id.toString() };
}

// =============================================================================================
// Customer sessions — refresh-token rotation
// =============================================================================================

export const REFRESH_TOKEN_PREFIX = 'rt_';
/** How many rotated-out hashes are remembered for replay detection. */
export const MAX_PREVIOUS_HASHES = 10;
export const LAST_USED_TOUCH_INTERVAL_MS = 60_000;

/** `rt_<sessionPublicId>.<secret>` — embedding the session id gives O(1) lookup and lets us tell a replay from a forgery. */
export function generateRefreshToken(sessionPublicId: string): string {
  return `${REFRESH_TOKEN_PREFIX}${sessionPublicId}.${generateOpaqueToken(32)}`;
}

export function parseRefreshToken(token: string): { sessionPublicId: string } | null {
  if (!token.startsWith(REFRESH_TOKEN_PREFIX) || token.length > 256) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const sessionPublicId = token.slice(REFRESH_TOKEN_PREFIX.length, dot);
  if (!sessionPublicId.startsWith(`${IdPrefixes.session}_`) || token.length - dot < 16) return null;
  return { sessionPublicId };
}

export type RefreshDecision =
  | { kind: 'rotate' }
  /** Web only: the previous token was presented again within the grace window. */
  | { kind: 'grace' }
  /** A token that was rotated out earlier was replayed ⇒ treat as theft. */
  | { kind: 'reuse' }
  | { kind: 'revoked' }
  | { kind: 'expired' }
  | { kind: 'invalid' };

export type RefreshSessionView = Pick<
  CustomerSessionShape,
  | 'client'
  | 'refreshTokenHash'
  | 'previousHashes'
  | 'gracePreviousHash'
  | 'graceUntil'
  | 'revokedAt'
  | 'absoluteExpiresAt'
>;

/**
 * Pure policy function (unit-tested): decides what a presented refresh-token hash means.
 *
 *  - mobile: any replay of a rotated token ⇒ `reuse` (family revoked, `auth/refresh-reused`)
 *  - web:    the previous token is tolerated for `graceUntil` (10 s, W-10); a later replay ⇒ `reuse`
 *  - a hash that was never issued for this session ⇒ `invalid` (never revokes: session ids are
 *    not secret, so a forged token must not be able to log a victim out)
 */
export function evaluateRefresh(
  session: RefreshSessionView,
  presentedHash: string,
  now: Date,
): RefreshDecision {
  if (session.revokedAt) return { kind: 'revoked' };
  if (session.absoluteExpiresAt.getTime() <= now.getTime()) return { kind: 'expired' };
  if (safeEqual(presentedHash, session.refreshTokenHash)) return { kind: 'rotate' };

  if (
    session.client === 'web' &&
    session.gracePreviousHash &&
    session.graceUntil &&
    safeEqual(presentedHash, session.gracePreviousHash)
  ) {
    return session.graceUntil.getTime() > now.getTime() ? { kind: 'grace' } : { kind: 'reuse' };
  }
  if (session.previousHashes.some((h) => safeEqual(presentedHash, h))) return { kind: 'reuse' };
  return { kind: 'invalid' };
}

/** Maps a failed refresh to the client's own error code (mobile §4.3, web §3). */
export function refreshFailure(client: CustomerClient, kind: 'reuse' | 'invalid'): AppError {
  if (client === 'mobile') {
    return kind === 'reuse'
      ? unauthorized('auth/refresh-reused', 'This session was signed out for your security. Sign in again.')
      : unauthorized('auth/token-invalid', 'Your session is no longer valid. Sign in again.');
  }
  return unauthorized('auth/session-expired', 'Your session has expired. Sign in again.');
}

function refreshTtlSeconds(client: CustomerClient): number {
  const env = loadEnv();
  return client === 'mobile' ? env.MOBILE_REFRESH_TTL_SECONDS : env.WEB_REFRESH_TTL_SECONDS;
}

export interface IssuedCustomerSession {
  session: CustomerSessionRecord;
  /** Plaintext — returned once, only the hash is stored. */
  refreshToken: string;
}

export async function createCustomerSession(input: {
  userId: string;
  client: CustomerClient;
  device?: DeviceInfo;
  now?: Date;
  /** False only when the web user unchecks "Keep me signed in". Defaults to persistent. */
  persistent?: boolean;
}): Promise<IssuedCustomerSession> {
  const now = input.now ?? new Date();
  const publicId = opaqueId(IdPrefixes.session);
  const refreshToken = generateRefreshToken(publicId);
  const device = input.device ?? {};

  // One live session per (user, client, device): a fresh login replaces the old one.
  if (device.id) {
    await CustomerSessionModel.updateMany(
      { userId: input.userId, client: input.client, 'device.id': device.id, revokedAt: null },
      { $set: { revokedAt: now, revokedReason: 'replaced' satisfies RevokeReason } },
    );
  }

  const doc = await CustomerSessionModel.create({
    publicId,
    userId: new Types.ObjectId(input.userId),
    client: input.client,
    familyId: opaqueId('fam'),
    device,
    refreshTokenHash: hashToken(refreshToken),
    previousHashes: [],
    rotationCount: 0,
    persistent: input.persistent !== false,
    absoluteExpiresAt: new Date(now.getTime() + refreshTtlSeconds(input.client) * 1000),
    lastUsedAt: now,
  });
  return { session: toCustomerRecord(doc.toObject() as unknown as WithId<CustomerSessionShape>)!, refreshToken };
}

export async function findCustomerSessionByPublicId(publicId: string): Promise<CustomerSessionRecord | null> {
  return toCustomerRecord(await CustomerSessionModel.findOne({ publicId }).lean<WithId<CustomerSessionShape>>());
}

/** Active = not revoked and not past the absolute expiry. */
export async function findActiveCustomerSession(
  publicId: string,
  now = new Date(),
): Promise<CustomerSessionRecord | null> {
  const s = await findCustomerSessionByPublicId(publicId);
  if (!s || s.revokedAt || s.absoluteExpiresAt.getTime() <= now.getTime()) return null;
  return s;
}

export interface RotationResult {
  session: CustomerSessionRecord;
  /** Undefined when the presented token was accepted under the web grace rule (no new cookie). */
  refreshToken?: string;
  rotated: boolean;
}

/**
 * Exchanges a refresh token for the next one. Concurrency-safe: the swap is a single
 * compare-and-set on the current hash, so two parallel presentations of the same token cannot
 * both rotate — the loser is re-evaluated (grace or reuse).
 */
export async function rotateRefreshToken(input: {
  refreshToken: string;
  client: CustomerClient;
  device?: Partial<DeviceInfo>;
  now?: Date;
}): Promise<RotationResult> {
  const now = input.now ?? new Date();
  const parsed = parseRefreshToken(input.refreshToken);
  if (!parsed) throw refreshFailure(input.client, 'invalid');
  const presentedHash = hashToken(input.refreshToken);
  const env = loadEnv();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const session = await findCustomerSessionByPublicId(parsed.sessionPublicId);
    if (!session || session.client !== input.client) throw refreshFailure(input.client, 'invalid');

    const decision = evaluateRefresh(session, presentedHash, now);
    switch (decision.kind) {
      case 'grace':
        return { session, rotated: false };
      case 'reuse':
        logger.warn(
          { sessionId: session.publicId, familyId: session.familyId, client: session.client },
          'Refresh token reuse detected — revoking session family',
        );
        await revokeCustomerFamily(session.familyId, 'reuse_detected', now);
        throw refreshFailure(input.client, 'reuse');
      case 'revoked':
      case 'expired':
      case 'invalid':
        throw refreshFailure(input.client, 'invalid');
      case 'rotate': {
        const next = generateRefreshToken(session.publicId);
        const graceSeconds = input.client === 'web' ? env.REFRESH_REUSE_GRACE_SECONDS : 0;
        const $set: Record<string, unknown> = {
          refreshTokenHash: hashToken(next),
          lastUsedAt: now,
        };
        if (graceSeconds > 0) {
          $set.gracePreviousHash = presentedHash;
          $set.graceUntil = new Date(now.getTime() + graceSeconds * 1000);
        }
        if (input.device?.ip) $set['device.ip'] = input.device.ip;
        if (input.device?.userAgent) $set['device.userAgent'] = input.device.userAgent;
        const updated = await CustomerSessionModel.findOneAndUpdate(
          {
            publicId: session.publicId,
            refreshTokenHash: presentedHash,
            revokedAt: null,
            absoluteExpiresAt: { $gt: now },
          },
          {
            $set,
            $inc: { rotationCount: 1 },
            $push: { previousHashes: { $each: [presentedHash], $slice: -MAX_PREVIOUS_HASHES } },
          },
          { new: true },
        ).lean<WithId<CustomerSessionShape>>();
        if (updated) return { session: toCustomerRecord(updated)!, refreshToken: next, rotated: true };
        // Lost a race with a parallel refresh — loop and re-evaluate against the new state.
        break;
      }
    }
  }
  throw refreshFailure(input.client, 'invalid');
}

/**
 * Forces a rotation without a presented token (web password change: "rotates the refresh cookie
 * for the caller"). The old token keeps the normal grace treatment.
 */
export async function forceRotateCustomerSession(
  publicId: string,
  now = new Date(),
): Promise<IssuedCustomerSession | null> {
  const session = await findActiveCustomerSession(publicId, now);
  if (!session) return null;
  const next = generateRefreshToken(publicId);
  const graceSeconds = session.client === 'web' ? loadEnv().REFRESH_REUSE_GRACE_SECONDS : 0;
  const $set: Record<string, unknown> = { refreshTokenHash: hashToken(next), lastUsedAt: now };
  if (graceSeconds > 0) {
    $set.gracePreviousHash = session.refreshTokenHash;
    $set.graceUntil = new Date(now.getTime() + graceSeconds * 1000);
  }
  const updated = await CustomerSessionModel.findOneAndUpdate(
    { publicId, revokedAt: null },
    {
      $set,
      $inc: { rotationCount: 1 },
      $push: { previousHashes: { $each: [session.refreshTokenHash], $slice: -MAX_PREVIOUS_HASHES } },
    },
    { new: true },
  ).lean<WithId<CustomerSessionShape>>();
  return updated ? { session: toCustomerRecord(updated)!, refreshToken: next } : null;
}

export async function revokeCustomerSession(
  publicId: string,
  userId: string,
  reason: RevokeReason,
  now = new Date(),
): Promise<boolean> {
  const res = await CustomerSessionModel.updateOne(
    { publicId, userId, revokedAt: null },
    { $set: { revokedAt: now, revokedReason: reason } },
  );
  return res.modifiedCount > 0;
}

/**
 * Logout by refresh token (web `POST /auth/logout`: the access token may already have expired).
 * Only a holder of a token that was genuinely issued for the session — current, graced or
 * previously rotated — can revoke it, so a bare session id is never enough.
 */
export async function revokeSessionByRefreshToken(
  refreshToken: string,
  client: CustomerClient,
  reason: RevokeReason = 'sign_out',
  now = new Date(),
): Promise<boolean> {
  const parsed = parseRefreshToken(refreshToken);
  if (!parsed) return false;
  const session = await findCustomerSessionByPublicId(parsed.sessionPublicId);
  if (!session || session.client !== client || session.revokedAt) return false;
  const hash = hashToken(refreshToken);
  const decision = evaluateRefresh(session, hash, now);
  if (decision.kind === 'invalid' || decision.kind === 'revoked' || decision.kind === 'expired') return false;
  return revokeCustomerSession(session.publicId, session.userId.toString(), reason, now);
}

export async function revokeCustomerFamily(
  familyId: string,
  reason: RevokeReason,
  now = new Date(),
): Promise<number> {
  const res = await CustomerSessionModel.updateMany(
    { familyId, revokedAt: null },
    { $set: { revokedAt: now, revokedReason: reason } },
  );
  return res.modifiedCount;
}

export async function revokeAllCustomerSessions(
  userId: string,
  opts: { exceptPublicId?: string; reason: RevokeReason; now?: Date },
): Promise<number> {
  const res = await CustomerSessionModel.updateMany(
    {
      userId,
      revokedAt: null,
      ...(opts.exceptPublicId ? { publicId: { $ne: opts.exceptPublicId } } : {}),
    },
    { $set: { revokedAt: opts.now ?? new Date(), revokedReason: opts.reason } },
  );
  return res.modifiedCount;
}

export async function listActiveCustomerSessions(
  userId: string,
  now = new Date(),
): Promise<CustomerSessionRecord[]> {
  const rows = await CustomerSessionModel.find({
    userId,
    revokedAt: null,
    absoluteExpiresAt: { $gt: now },
  })
    .sort({ lastUsedAt: -1 })
    .lean<Array<WithId<CustomerSessionShape>>>();
  return rows.map((r) => toCustomerRecord(r)!);
}

/** Cheap, throttled "last active" bump used by the access-token middleware. */
export async function touchCustomerSession(publicId: string, now = new Date()): Promise<void> {
  await CustomerSessionModel.updateOne(
    { publicId, lastUsedAt: { $lt: new Date(now.getTime() - LAST_USED_TOUCH_INTERVAL_MS) } },
    { $set: { lastUsedAt: now } },
  );
}

export async function updateSessionPushToken(publicId: string, pushToken: string): Promise<void> {
  await CustomerSessionModel.updateOne({ publicId }, { $set: { 'device.pushToken': pushToken } });
}

// =============================================================================================
// Staff (admin console) sessions — opaque cookie + CSRF
// =============================================================================================

export const MAX_UNLOCK_FAILURES = 5;
export const STAFF_TOUCH_INTERVAL_MS = 30_000;

function staffSessionPublicId(): string {
  return `SES-${generateOpaqueToken(6).replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase()}`;
}

/**
 * Double-submit CSRF token, derived from the session token so `GET /me` (which only has the
 * cookie) can re-issue it. Only its sha256 is stored (`csrfTokenHash`) and compared.
 */
export function deriveCsrfToken(sessionToken: string, secret = loadEnv().ADMIN_SESSION_SECRET): string {
  return createHmac('sha256', secret).update(`csrf:${sessionToken}`).digest('base64url');
}

export function staffSessionExpiresAt(s: Pick<StaffSessionShape, 'idleExpiresAt' | 'absoluteExpiresAt'>): Date {
  return s.idleExpiresAt.getTime() < s.absoluteExpiresAt.getTime() ? s.idleExpiresAt : s.absoluteExpiresAt;
}

export type StaffSessionStatus = 'ok' | 'revoked' | 'idle_expired' | 'absolute_expired';

/** Pure: `locked` sessions are still `ok` (the lock is enforced separately by `requireUnlockedConsole`). */
export function evaluateStaffSession(
  s: Pick<StaffSessionShape, 'revokedAt' | 'idleExpiresAt' | 'absoluteExpiresAt'>,
  now: Date,
): StaffSessionStatus {
  if (s.revokedAt) return 'revoked';
  if (s.absoluteExpiresAt.getTime() <= now.getTime()) return 'absolute_expired';
  if (s.idleExpiresAt.getTime() <= now.getTime()) return 'idle_expired';
  return 'ok';
}

export function verifyCsrfToken(session: Pick<StaffSessionShape, 'csrfTokenHash'>, presented: string): boolean {
  return presented.length > 0 && presented.length < 256 && safeEqual(hashToken(presented), session.csrfTokenHash);
}

function nextIdleExpiry(now: Date, absoluteExpiresAt: Date): Date {
  const idle = new Date(now.getTime() + loadEnv().ADMIN_IDLE_TIMEOUT_SECONDS * 1000);
  return idle.getTime() < absoluteExpiresAt.getTime() ? idle : absoluteExpiresAt;
}

export interface IssuedStaffSession {
  session: StaffSessionRecord;
  sessionToken: string;
  csrfToken: string;
}

export async function createStaffSession(input: {
  staffId: string;
  device?: DeviceInfo;
  now?: Date;
}): Promise<IssuedStaffSession> {
  const env = loadEnv();
  const now = input.now ?? new Date();
  const sessionToken = generateOpaqueToken(32);
  const csrfToken = deriveCsrfToken(sessionToken);
  const absoluteExpiresAt = new Date(now.getTime() + env.ADMIN_ABSOLUTE_TTL_SECONDS * 1000);
  const doc = await StaffSessionModel.create({
    publicId: staffSessionPublicId(),
    staffId: new Types.ObjectId(input.staffId),
    sessionTokenHash: hashToken(sessionToken),
    csrfTokenHash: hashToken(csrfToken),
    state: 'active',
    idleExpiresAt: nextIdleExpiry(now, absoluteExpiresAt),
    absoluteExpiresAt,
    device: input.device ?? {},
    lastUsedAt: now,
  });
  return {
    session: toStaffRecord(doc.toObject() as unknown as WithId<StaffSessionShape>)!,
    sessionToken,
    csrfToken,
  };
}

export async function findStaffSessionByToken(token: string): Promise<StaffSessionRecord | null> {
  if (!token || token.length > 256) return null;
  return toStaffRecord(
    await StaffSessionModel.findOne({ sessionTokenHash: hashToken(token) }).lean<WithId<StaffSessionShape>>(),
  );
}

export async function findStaffSessionByPublicId(publicId: string): Promise<StaffSessionRecord | null> {
  return toStaffRecord(await StaffSessionModel.findOne({ publicId }).lean<WithId<StaffSessionShape>>());
}

/** Rotates the cookie + CSRF token (`POST /auth/refresh`) and slides the idle deadline. */
export async function rotateStaffSession(
  session: StaffSessionRecord,
  now = new Date(),
): Promise<IssuedStaffSession | null> {
  const sessionToken = generateOpaqueToken(32);
  const csrfToken = deriveCsrfToken(sessionToken);
  const updated = await StaffSessionModel.findOneAndUpdate(
    { _id: session.id, revokedAt: null, sessionTokenHash: session.sessionTokenHash },
    {
      $set: {
        sessionTokenHash: hashToken(sessionToken),
        csrfTokenHash: hashToken(csrfToken),
        idleExpiresAt: nextIdleExpiry(now, session.absoluteExpiresAt),
        lastUsedAt: now,
      },
    },
    { new: true },
  ).lean<WithId<StaffSessionShape>>();
  return updated ? { session: toStaffRecord(updated)!, sessionToken, csrfToken } : null;
}

export async function lockStaffSession(session: StaffSessionRecord, now = new Date()): Promise<StaffSessionRecord> {
  const updated = await StaffSessionModel.findOneAndUpdate(
    { _id: session.id, revokedAt: null },
    { $set: { state: 'locked', lockedAt: now, failedUnlockCount: 0 } },
    { new: true },
  ).lean<WithId<StaffSessionShape>>();
  return toStaffRecord(updated) ?? session;
}

export async function unlockStaffSession(session: StaffSessionRecord, now = new Date()): Promise<StaffSessionRecord> {
  const updated = await StaffSessionModel.findOneAndUpdate(
    { _id: session.id, revokedAt: null },
    {
      $set: {
        state: 'active',
        failedUnlockCount: 0,
        idleExpiresAt: nextIdleExpiry(now, session.absoluteExpiresAt),
        lastUsedAt: now,
      },
      $unset: { lockedAt: 1 },
    },
    { new: true },
  ).lean<WithId<StaffSessionShape>>();
  return toStaffRecord(updated) ?? session;
}

/** Counts a bad unlock password; at 5 the session is revoked (⇒ `401 auth/session-expired`). */
export async function registerUnlockFailure(
  session: StaffSessionRecord,
  now = new Date(),
): Promise<{ failures: number; revoked: boolean }> {
  const updated = await StaffSessionModel.findOneAndUpdate(
    { _id: session.id, revokedAt: null },
    { $inc: { failedUnlockCount: 1 } },
    { new: true, projection: { failedUnlockCount: 1 } },
  ).lean<{ failedUnlockCount: number }>();
  const failures = updated?.failedUnlockCount ?? MAX_UNLOCK_FAILURES;
  if (failures >= MAX_UNLOCK_FAILURES) {
    await revokeStaffSession(session.id, 'too_many_unlock_failures', now);
    return { failures, revoked: true };
  }
  return { failures, revoked: false };
}

export async function revokeStaffSession(id: string, reason: string, now = new Date()): Promise<boolean> {
  if (!isValidObjectId(id)) return false;
  const res = await StaffSessionModel.updateOne(
    { _id: id, revokedAt: null },
    { $set: { revokedAt: now, revokedReason: reason } },
  );
  return res.modifiedCount > 0;
}

export async function revokeAllStaffSessions(
  staffId: string,
  opts: { exceptId?: string; reason: string; now?: Date },
): Promise<number> {
  const res = await StaffSessionModel.updateMany(
    {
      staffId,
      revokedAt: null,
      ...(opts.exceptId ? { _id: { $ne: opts.exceptId } } : {}),
    },
    { $set: { revokedAt: opts.now ?? new Date(), revokedReason: opts.reason } },
  );
  return res.modifiedCount;
}

export async function touchStaffSession(id: string, now = new Date()): Promise<void> {
  await StaffSessionModel.updateOne(
    { _id: id, lastUsedAt: { $lt: new Date(now.getTime() - STAFF_TOUCH_INTERVAL_MS) } },
    { $set: { lastUsedAt: now } },
  );
}

export async function listActiveStaffSessions(staffId: string, now = new Date()): Promise<StaffSessionRecord[]> {
  const rows = await StaffSessionModel.find({
    staffId,
    revokedAt: null,
    absoluteExpiresAt: { $gt: now },
    idleExpiresAt: { $gt: now },
  })
    .sort({ lastUsedAt: -1 })
    .lean<Array<WithId<StaffSessionShape>>>();
  return rows.map((r) => toStaffRecord(r)!);
}
