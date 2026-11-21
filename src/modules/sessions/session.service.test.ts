import { describe, expect, it } from 'vitest';
import { hashToken } from '../../common/utils/crypto.js';
import { loadEnv } from '../../config/env.js';
import {
  deriveCsrfToken,
  evaluateRefresh,
  evaluateStaffSession,
  generateRefreshToken,
  nextIdleExpiry,
  parseRefreshToken,
  refreshFailure,
  staffSessionExpiresAt,
  verifyCsrfToken,
  type RefreshSessionView,
} from './session.service.js';

const NOW = new Date('2026-10-16T10:00:00Z');
const FUTURE = new Date(NOW.getTime() + 86_400_000);
const at = (ms: number) => new Date(NOW.getTime() + ms);

const CURRENT = hashToken('rt_current');
const OLD = hashToken('rt_old');
const OLDER = hashToken('rt_older');

function session(over: Partial<RefreshSessionView> = {}): RefreshSessionView {
  return {
    client: 'mobile',
    refreshTokenHash: CURRENT,
    previousHashes: [OLD, OLDER],
    absoluteExpiresAt: FUTURE,
    ...over,
  } as RefreshSessionView;
}

describe('evaluateRefresh (rotation + reuse detection)', () => {
  it('rotates when the current token is presented', () => {
    expect(evaluateRefresh(session(), CURRENT, NOW)).toEqual({ kind: 'rotate' });
  });

  it('mobile: replay of a rotated-out token is reuse (family revoked)', () => {
    expect(evaluateRefresh(session(), OLD, NOW)).toEqual({ kind: 'reuse' });
    expect(evaluateRefresh(session(), OLDER, NOW)).toEqual({ kind: 'reuse' });
  });

  it('mobile ignores the web grace fields', () => {
    const s = session({ gracePreviousHash: OLD, graceUntil: at(5_000) });
    expect(evaluateRefresh(s, OLD, NOW)).toEqual({ kind: 'reuse' });
  });

  it('web: previous token inside the 10 s grace window is tolerated', () => {
    const s = session({ client: 'web', gracePreviousHash: OLD, graceUntil: at(10_000) });
    expect(evaluateRefresh(s, OLD, NOW)).toEqual({ kind: 'grace' });
    expect(evaluateRefresh(s, OLD, at(9_999))).toEqual({ kind: 'grace' });
  });

  it('web: the same previous token after the window is reuse', () => {
    const s = session({ client: 'web', gracePreviousHash: OLD, graceUntil: at(10_000) });
    expect(evaluateRefresh(s, OLD, at(10_001))).toEqual({ kind: 'reuse' });
  });

  it('web: older tokens are reuse even inside the window', () => {
    const s = session({ client: 'web', gracePreviousHash: OLD, graceUntil: at(10_000) });
    expect(evaluateRefresh(s, OLDER, NOW)).toEqual({ kind: 'reuse' });
  });

  it('a token that was never issued is invalid, not reuse (a forger must not log a victim out)', () => {
    expect(evaluateRefresh(session(), hashToken('forged'), NOW)).toEqual({ kind: 'invalid' });
  });

  it('revoked sessions stay revoked, even for the current token', () => {
    expect(evaluateRefresh(session({ revokedAt: NOW }), CURRENT, NOW)).toEqual({ kind: 'revoked' });
  });

  it('expires at the absolute deadline regardless of activity', () => {
    expect(evaluateRefresh(session({ absoluteExpiresAt: at(-1) }), CURRENT, NOW)).toEqual({ kind: 'expired' });
    expect(evaluateRefresh(session({ absoluteExpiresAt: NOW }), CURRENT, NOW)).toEqual({ kind: 'expired' });
  });
});

describe('refreshFailure', () => {
  it('mobile uses auth/refresh-reused and auth/token-invalid', () => {
    expect(refreshFailure('mobile', 'reuse')).toMatchObject({ status: 401, code: 'auth/refresh-reused' });
    expect(refreshFailure('mobile', 'invalid')).toMatchObject({ status: 401, code: 'auth/token-invalid' });
  });
  it('web always answers auth/session-expired', () => {
    expect(refreshFailure('web', 'reuse').code).toBe('auth/session-expired');
    expect(refreshFailure('web', 'invalid').code).toBe('auth/session-expired');
  });
});

describe('refresh token format', () => {
  it('round-trips the session id', () => {
    const t = generateRefreshToken('ses_ABC123');
    expect(parseRefreshToken(t)).toEqual({ sessionPublicId: 'ses_ABC123' });
  });
  it('generates distinct tokens', () => {
    expect(generateRefreshToken('ses_A')).not.toBe(generateRefreshToken('ses_A'));
  });
  it('rejects malformed tokens', () => {
    expect(parseRefreshToken('')).toBeNull();
    expect(parseRefreshToken('abc.def')).toBeNull();
    expect(parseRefreshToken('rt_nodot')).toBeNull();
    expect(parseRefreshToken('rt_usr_1.aaaaaaaaaaaaaaaaaaaaaaaa')).toBeNull();
    expect(parseRefreshToken(`rt_ses_1.${'a'.repeat(300)}`)).toBeNull();
  });
});

describe('evaluateStaffSession', () => {
  const base = { revokedAt: undefined, idleExpiresAt: at(60_000), absoluteExpiresAt: FUTURE };
  it('is ok while within both deadlines', () => {
    expect(evaluateStaffSession(base, NOW)).toBe('ok');
  });
  it('reports idle and absolute expiry and revocation', () => {
    expect(evaluateStaffSession({ ...base, idleExpiresAt: at(-1) }, NOW)).toBe('idle_expired');
    expect(evaluateStaffSession({ ...base, absoluteExpiresAt: at(-1) }, NOW)).toBe('absolute_expired');
    expect(evaluateStaffSession({ ...base, revokedAt: NOW }, NOW)).toBe('revoked');
  });
  it('expiresAt is the earlier deadline', () => {
    expect(staffSessionExpiresAt(base)).toEqual(at(60_000));
    expect(staffSessionExpiresAt({ idleExpiresAt: FUTURE, absoluteExpiresAt: at(1_000) })).toEqual(at(1_000));
  });
  it('slides the idle deadline forward without passing the absolute cap', () => {
    const idleMs = loadEnv().ADMIN_IDLE_TIMEOUT_SECONDS * 1000;
    expect(nextIdleExpiry(NOW, new Date(NOW.getTime() + idleMs * 2)).getTime()).toBe(NOW.getTime() + idleMs);
    const soon = new Date(NOW.getTime() + 5_000);
    expect(nextIdleExpiry(NOW, soon).getTime()).toBe(soon.getTime());
  });
});

describe('admin CSRF token', () => {
  it('is derived deterministically from the session token', () => {
    expect(deriveCsrfToken('tok')).toBe(deriveCsrfToken('tok'));
    expect(deriveCsrfToken('tok')).not.toBe(deriveCsrfToken('tok2'));
  });
  it('verifies against the stored hash only', () => {
    const csrfTokenHash = hashToken(deriveCsrfToken('tok'));
    expect(verifyCsrfToken({ csrfTokenHash }, deriveCsrfToken('tok'))).toBe(true);
    expect(verifyCsrfToken({ csrfTokenHash }, deriveCsrfToken('other'))).toBe(false);
    expect(verifyCsrfToken({ csrfTokenHash }, '')).toBe(false);
    expect(verifyCsrfToken({ csrfTokenHash }, 'x'.repeat(300))).toBe(false);
  });
});
