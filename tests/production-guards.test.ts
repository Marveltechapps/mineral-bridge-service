import { describe, expect, it } from 'vitest';
import { productionGuardFailures } from '../src/config/production-guards.js';

const strong = {
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  ADMIN_SESSION_SECRET: 'c'.repeat(40),
  WS_TOKEN_SECRET: 'd'.repeat(40),
};

const splitCors = {
  corsWebOrigins: ['https://app.mineralbridge.test'],
  corsAdminOrigins: ['https://admin.mineralbridge.test'],
  allowedOrigins: '',
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
        ...splitCors,
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
      corsWebOrigins: ['http://localhost:3100', 'https://admin.mineralbridge.test'],
      corsAdminOrigins: ['https://admin.mineralbridge.test'],
      allowedOrigins: 'https://app.mineralbridge.test,https://admin.mineralbridge.test',
    });
    const text = failures.join('\n');
    expect(text).toMatch(/OTP_PROVIDER=fake/);
    expect(text).toMatch(/EMAIL_PROVIDER=fake/);
    expect(text).toMatch(/COOKIE_SECURE/);
    expect(text).toMatch(/OTP_TEST_OTP/);
    expect(text).toMatch(/DEBUG_MODE/);
    expect(text).toMatch(/ALLOWED_ORIGINS must be unset/);
    expect(text).toMatch(/must be disjoint/);
    expect(text).toMatch(/must use https/);
  });

  it('rejects a production config that only set the legacy combined allow-list', () => {
    const failures = productionGuardFailures({
      nodeEnv: 'production',
      otpProvider: 'twilio',
      emailProvider: 'resend',
      cookieSecure: true,
      secrets: strong,
      corsWebOrigins: [],
      corsAdminOrigins: [],
      allowedOrigins: 'https://app.mineralbridge.test,https://admin.mineralbridge.test',
    });
    const text = failures.join('\n');
    expect(text).toMatch(/CORS_WEB_ORIGINS must list/);
    expect(text).toMatch(/CORS_ADMIN_ORIGINS must list/);
    expect(text).toMatch(/ALLOWED_ORIGINS must be unset/);
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
