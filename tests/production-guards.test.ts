import { describe, expect, it } from 'vitest';
import { productionGuardFailures } from '../src/config/production-guards.js';

const strong = {
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  ADMIN_SESSION_SECRET: 'c'.repeat(40),
  WS_TOKEN_SECRET: 'd'.repeat(40),
};

describe('production configuration guards', () => {
  it('allows a hardened production configuration', () => {
    expect(
      productionGuardFailures({
        nodeEnv: 'production',
        otpProvider: 'twilio',
        emailProvider: 'resend',
        cookieSecure: true,
        secrets: strong,
      }),
    ).toEqual([]);
  });

  it('rejects fake OTP, fake email, insecure cookies, weak secrets, and a fixed test OTP', () => {
    const failures = productionGuardFailures({
      nodeEnv: 'production',
      otpProvider: 'fake',
      emailProvider: 'fake',
      cookieSecure: false,
      secrets: { JWT_ACCESS_SECRET: 'dev-access-secret-min-32-characters!!' },
      otpTestOtp: '1234',
      debugMode: '1',
    });
    expect(failures.join('\n')).toMatch(/OTP_PROVIDER=fake/);
    expect(failures.join('\n')).toMatch(/EMAIL_PROVIDER=fake/);
    expect(failures.join('\n')).toMatch(/COOKIE_SECURE/);
    expect(failures.join('\n')).toMatch(/OTP_TEST_OTP/);
    expect(failures.join('\n')).toMatch(/DEBUG_MODE/);
  });

  it('does not apply the production rules outside production', () => {
    expect(
      productionGuardFailures({
        nodeEnv: 'test',
        otpProvider: 'fake',
        emailProvider: 'fake',
        cookieSecure: false,
        secrets: {},
        otpTestOtp: '1234',
      }),
    ).toEqual([]);
  });
});
