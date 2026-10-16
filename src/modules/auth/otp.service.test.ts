import { describe, expect, it } from 'vitest';
import {
  OtpFailure,
  hashOtpCode,
  isThrottled,
  otpFailureToAppError,
  otpPolicy,
  verifyOtpCode,
  type OtpFailureReason,
} from './otp.service.js';

const SECRET = 'unit-test-secret-unit-test-secret!';

describe('OTP hashing', () => {
  it('is deterministic for the same challenge, code and secret', () => {
    expect(hashOtpCode('chl_1', '482910', SECRET)).toBe(hashOtpCode('chl_1', '482910', SECRET));
  });

  it('never contains the plaintext code and is a sha256 hex digest', () => {
    const h = hashOtpCode('chl_1', '482910', SECRET);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain('482910');
  });

  it('is bound to the challenge id (a hash cannot be replayed on another challenge)', () => {
    expect(hashOtpCode('chl_1', '482910', SECRET)).not.toBe(hashOtpCode('chl_2', '482910', SECRET));
  });

  it('is keyed (a database dump alone cannot be brute-forced)', () => {
    expect(hashOtpCode('chl_1', '482910', SECRET)).not.toBe(hashOtpCode('chl_1', '482910', `${SECRET}x`));
  });

  it('verifies the right code and rejects wrong, malformed and cross-challenge codes', () => {
    const hash = hashOtpCode('chl_1', '482910', SECRET);
    expect(verifyOtpCode('chl_1', '482910', hash, SECRET)).toBe(true);
    expect(verifyOtpCode('chl_1', '482911', hash, SECRET)).toBe(false);
    expect(verifyOtpCode('chl_2', '482910', hash, SECRET)).toBe(false);
    expect(verifyOtpCode('chl_1', '48291a', hash, SECRET)).toBe(false);
    expect(verifyOtpCode('chl_1', '', hash, SECRET)).toBe(false);
  });

  it('does not distinguish a short hash from a wrong one (no exception)', () => {
    expect(verifyOtpCode('chl_1', '482910', 'abc', SECRET)).toBe(false);
  });
});

describe('isThrottled', () => {
  it('allows up to the limit and blocks beyond it', () => {
    expect(isThrottled(3, 3)).toBe(false);
    expect(isThrottled(4, 3)).toBe(true);
    expect(isThrottled(0, 3)).toBe(false);
  });
});

describe('otpPolicy', () => {
  it('uses 6 digits for mobile and admin, 4 for web (W-9)', () => {
    expect(otpPolicy('mobile').codeLength).toBe(6);
    expect(otpPolicy('admin').codeLength).toBe(6);
    expect(otpPolicy('web').codeLength).toBe(4);
  });

  it('allows email only for web and admin', () => {
    expect(otpPolicy('mobile').allowedChannels).not.toContain('email');
    expect(otpPolicy('web').allowedChannels).toContain('email');
    expect(otpPolicy('admin').allowedChannels).toContain('email');
  });

  it('uses the contract resend cooldowns', () => {
    expect(otpPolicy('mobile').resendCooldownSeconds).toBe(42);
    expect(otpPolicy('web').resendCooldownSeconds).toBe(30);
  });
});

describe('otpFailureToAppError (per-client vocabularies)', () => {
  const map = (client: 'mobile' | 'web' | 'admin', reason: OtpFailureReason, opts = {}) =>
    otpFailureToAppError(client, new OtpFailure(reason, opts));

  it('mobile', () => {
    expect(map('mobile', 'invalid', { attemptsLeft: 2 })).toMatchObject({ status: 422, code: 'auth/otp-invalid' });
    expect(map('mobile', 'expired')).toMatchObject({ status: 410, code: 'auth/otp-expired' });
    expect(map('mobile', 'attempts_exceeded')).toMatchObject({ status: 429, code: 'auth/otp-attempts-exceeded' });
    expect(map('mobile', 'throttled')).toMatchObject({ status: 429, code: 'auth/otp-rate-limited' });
  });

  it('web', () => {
    expect(map('web', 'invalid')).toMatchObject({ status: 422, code: 'auth/otp-incorrect' });
    expect(map('web', 'expired')).toMatchObject({ status: 401, code: 'auth/otp-expired' });
    // "5 wrong codes invalidates the challenge -> auth/otp-expired"
    expect(map('web', 'attempts_exceeded')).toMatchObject({ status: 401, code: 'auth/otp-expired' });
    expect(map('web', 'cooldown')).toMatchObject({ status: 429, code: 'auth/otp-throttled' });
  });

  it('admin', () => {
    expect(map('admin', 'invalid', { attemptsLeft: 3 })).toMatchObject({ status: 401, code: 'auth/invalid-otp' });
    expect(map('admin', 'expired')).toMatchObject({ status: 410, code: 'auth/challenge-expired' });
    expect(map('admin', 'attempts_exceeded')).toMatchObject({ status: 423, code: 'auth/challenge-locked' });
    expect(map('admin', 'throttled')).toMatchObject({ status: 429, code: 'rate-limited' });
  });

  it('carries retryAfterSeconds on throttling', () => {
    expect(map('mobile', 'cooldown', { retryAfterSeconds: 17 }).details).toEqual({ retryAfterSeconds: 17 });
  });

  it('never puts a code in an error', () => {
    const json = JSON.stringify(map('mobile', 'invalid', { attemptsLeft: 1 }));
    expect(json).not.toMatch(/\d{6}/);
  });
});
