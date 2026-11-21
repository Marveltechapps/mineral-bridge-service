import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';

const WEB = 'http://web.mb.test';
const ADMIN = 'http://admin.mb.test';

describe('CORS is scoped per API surface', () => {
  let app: Express;
  beforeAll(async () => {
    process.env.CORS_WEB_ORIGINS = WEB;
    process.env.CORS_ADMIN_ORIGINS = ADMIN;
    process.env.CORS_MOBILE_ORIGINS = '';
    const prevAllowed = process.env.ALLOWED_ORIGINS;
    process.env.ALLOWED_ORIGINS = '';
    const { resetEnvCache } = await import('../src/config/env.js');
    resetEnvCache();
    const { createApp } = await import('../src/app.js');
    app = createApp();
    process.env.ALLOWED_ORIGINS = prevAllowed;
    resetEnvCache();
  });

  const preflight = (path: string, origin: string) =>
    request(app).options(path).set('Origin', origin).set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type');

  it('customer routes allow the web origin', async () => {
    const r = await preflight('/v2/orders', WEB);
    expect(r.headers['access-control-allow-origin']).toBe(WEB);
  });

  it('admin routes allow the admin origin with credentials', async () => {
    const r = await preflight('/v2/admin/auth/sign-in', ADMIN);
    expect(r.headers['access-control-allow-origin']).toBe(ADMIN);
    expect(r.headers['access-control-allow-credentials']).toBe('true');
  });

  it('admin routes refuse a customer web origin', async () => {
    const r = await preflight('/v2/admin/auth/sign-in', WEB);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not copy ALLOWED_ORIGINS onto both lists in production', async () => {
    const { resetEnvCache, loadEnv } = await import('../src/config/env.js');
    const { productionGuardFailures } = await import('../src/config/production-guards.js');
    const keys = [
      'NODE_ENV',
      'CORS_WEB_ORIGINS',
      'CORS_ADMIN_ORIGINS',
      'CORS_MOBILE_ORIGINS',
      'ALLOWED_ORIGINS',
      'OTP_PROVIDER',
      'EMAIL_PROVIDER',
      'COOKIE_SECURE',
    ] as const;
    const prev = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.NODE_ENV = 'production';
    process.env.CORS_WEB_ORIGINS = 'https://app.mineralbridge.test';
    process.env.CORS_ADMIN_ORIGINS = 'https://admin.mineralbridge.test';
    process.env.CORS_MOBILE_ORIGINS = '';
    process.env.ALLOWED_ORIGINS = 'https://app.mineralbridge.test,https://admin.mineralbridge.test';
    process.env.OTP_PROVIDER = 'twilio';
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.COOKIE_SECURE = 'true';
    resetEnvCache();
    try {
      const env = loadEnv();
      expect(env.corsWebOrigins).toEqual(['https://app.mineralbridge.test']);
      expect(env.corsAdminOrigins).toEqual(['https://admin.mineralbridge.test']);
      expect(env.corsWebOrigins.some((origin) => env.corsAdminOrigins.includes(origin))).toBe(false);
      const failures = productionGuardFailures({
        nodeEnv: 'production',
        otpProvider: env.OTP_PROVIDER,
        emailProvider: env.EMAIL_PROVIDER,
        cookieSecure: env.COOKIE_SECURE,
        secrets: {
          JWT_ACCESS_SECRET: 'a'.repeat(40),
          JWT_REFRESH_SECRET: 'b'.repeat(40),
          ADMIN_SESSION_SECRET: 'c'.repeat(40),
          WS_TOKEN_SECRET: 'd'.repeat(40),
        },
        corsWebOrigins: env.corsWebOrigins,
        corsAdminOrigins: env.corsAdminOrigins,
        allowedOrigins: process.env.ALLOWED_ORIGINS,
      });
      expect(failures.join('\n')).toMatch(/ALLOWED_ORIGINS must be unset/);
      delete process.env.ALLOWED_ORIGINS;
      resetEnvCache();
      const clean = loadEnv();
      expect(clean.corsWebOrigins).toEqual(['https://app.mineralbridge.test']);
      expect(clean.corsAdminOrigins).toEqual(['https://admin.mineralbridge.test']);
      expect(
        productionGuardFailures({
          nodeEnv: 'production',
          otpProvider: 'twilio',
          emailProvider: 'resend',
          cookieSecure: true,
          secrets: {
            JWT_ACCESS_SECRET: 'a'.repeat(40),
            JWT_REFRESH_SECRET: 'b'.repeat(40),
            ADMIN_SESSION_SECRET: 'c'.repeat(40),
            WS_TOKEN_SECRET: 'd'.repeat(40),
          },
          corsWebOrigins: clean.corsWebOrigins,
          corsAdminOrigins: clean.corsAdminOrigins,
          allowedOrigins: '',
        }),
      ).toEqual([]);
    } finally {
      for (const key of keys) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
      resetEnvCache();
    }
  });

  it('an unknown origin is refused everywhere', async () => {
    for (const p of ['/v2/orders', '/v2/admin/me']) {
      const r = await preflight(p, 'https://evil.example');
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
    }
  });
});
