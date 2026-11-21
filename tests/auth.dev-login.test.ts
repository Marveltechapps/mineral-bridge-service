import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { errorHandler, notFoundHandler } from '../src/common/middleware/error-handler.js';
import { requestContext } from '../src/common/middleware/request-context.js';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { resetEnvCache } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { FakeEmailProvider, setEmailProvider } from '../src/integrations/email/email.provider.js';
import { createCustomerAuthRouter } from '../src/modules/auth/customer.routes.js';
import { isAcceptableDevOtp, readDevLoginConfig, type DevLoginConfig } from '../src/modules/auth/dev-login.config.js';
import { DevLoginAttemptModel, DevelopmentPrincipalModel } from '../src/modules/auth/dev-login.model.js';
import {
  startDevelopmentLogin,
  verifyAdminDevelopmentLogin,
  verifyAppDevelopmentLogin,
} from '../src/modules/auth/dev-login.service.js';
import { OtpChallengeModel } from '../src/modules/auth/otp.model.js';
import { resendWebOtp, verifyWebOtp } from '../src/modules/auth/auth.service.js';
import { verifyAccessToken } from '../src/modules/auth/auth.tokens.js';
import { buildAdminApp } from './helpers/admin-harness.js';
import { noPermissions } from '../src/modules/staff/default-roles.js';
import { createStaff, findStaffByEmail } from '../src/modules/staff/staff.service.js';
import { userRepository } from '../src/modules/users/user.repository.js';
import { useMemoryMongo } from './setup.js';

useMemoryMongo('auth_dev_login');

const APP_EMAIL = 'dev.app@example.com';
const APP_PASSWORD = 'local-app-password';
const APP_OTP = '8472';
const ADMIN_EMAIL = 'dev.admin@example.com';
const ADMIN_PASSWORD = 'local-admin-password';
const ADMIN_OTP = '9081';

function devConfig(overrides: Partial<DevLoginConfig> = {}): DevLoginConfig {
  const permissions = noPermissions();
  permissions.orders = 'view';
  return {
    nodeEnv: 'development',
    enabled: true,
    ttlSeconds: 120,
    maxCredentialAttempts: 3,
    maxOtpAttempts: 3,
    app: { email: APP_EMAIL, password: APP_PASSWORD, otp: APP_OTP },
    admin: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, otp: ADMIN_OTP, permissions },
    misconfigured: null,
    ...overrides,
  };
}

beforeAll(async () => {
  await connectDatabase(process.env.MONGODB_URI);
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
}, 120_000);

afterAll(async () => {
  await disconnectDatabase();
});

afterEach(async () => {
  setEmailProvider(null);
  vi.restoreAllMocks();
  const cols = await mongoose.connection.db?.collections();
  if (cols) await Promise.all(cols.map((collection) => collection.deleteMany({})));
});

describe('development login configuration', () => {
  const base = {
    NODE_ENV: 'development',
    DEV_LOGIN_ENABLED: true,
    DEV_LOGIN_EMAIL: APP_EMAIL,
    DEV_LOGIN_PASSWORD: APP_PASSWORD,
    DEV_LOGIN_OTP: '',
    DEV_ADMIN_LOGIN_EMAIL: ADMIN_EMAIL,
    DEV_ADMIN_LOGIN_PASSWORD: ADMIN_PASSWORD,
    DEV_ADMIN_LOGIN_OTP: ADMIN_OTP,
    DEV_ADMIN_PERMISSIONS: 'orders:view',
    DEV_LOGIN_OTP_TTL_SECONDS: 120,
    DEV_LOGIN_MAX_CREDENTIAL_ATTEMPTS: 5,
    OTP_MAX_ATTEMPTS: 5,
  };

  it('rejects a well-known code and a shared email', () => {
    expect(isAcceptableDevOtp('1234')).toBe(false);
    expect(isAcceptableDevOtp('0000')).toBe(false);
    expect(isAcceptableDevOtp(APP_OTP)).toBe(true);
    const weak = readDevLoginConfig({ ...base, DEV_LOGIN_OTP: '1234' });
    expect(weak.app).toBeNull();
    expect(weak.misconfigured).toContain('app-otp-rejected');
    const shared = readDevLoginConfig({ ...base, DEV_ADMIN_LOGIN_EMAIL: APP_EMAIL });
    expect(shared.app).toBeNull();
    expect(shared.admin).toBeNull();
    expect(shared.misconfigured).toContain('admin-email-matches-app');
  });

  it('keeps the feature off when the flag is false', () => {
    const config = readDevLoginConfig({ ...base, DEV_LOGIN_ENABLED: false });
    expect(config.enabled).toBe(false);
    expect(config.app).toBeNull();
    expect(config.admin).toBeNull();
  });
});

describe('development login flow', () => {
  it('issues a session only after the development code and keeps the buyer role', async () => {
    const info = vi.spyOn(logger, 'info');
    const warn = vi.spyOn(logger, 'warn');
    const started = await startDevelopmentLogin({
      config: devConfig(),
      audience: 'app',
      client: 'web',
      email: APP_EMAIL,
      password: APP_PASSWORD,
      ip: '203.0.113.10',
    });
    expect(started.developmentOtp).toBe(APP_OTP);
    expect(started.codeLength).toBe(4);
    const stored = await OtpChallengeModel.findOne({ challengeId: started.challengeId }).select('+codeHash').lean();
    expect(JSON.stringify(stored)).not.toContain(APP_PASSWORD);
    expect(stored?.codeHash).not.toBe(APP_OTP);

    const session = await verifyAppDevelopmentLogin({
      config: devConfig(),
      client: 'web',
      challengeId: started.challengeId,
      code: APP_OTP,
      device: {},
    });
    expect(session.user.roles).toEqual(['buyer']);
    expect(session.user.kycStatus).toBe('none');
    expect(session.tokens.refreshToken).toBeTruthy();
    const claims = verifyAccessToken(session.tokens.accessToken);
    expect(claims.ok && claims.claims.roles).toEqual(['buyer']);
    expect(await DevelopmentPrincipalModel.countDocuments({ audience: 'app' })).toBe(1);

    const logged = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
    expect(logged).not.toContain(APP_PASSWORD);
    expect(logged).not.toContain(APP_OTP);
    const attempts = await DevLoginAttemptModel.find().lean();
    expect(JSON.stringify(attempts)).not.toContain(APP_PASSWORD);
  });

  it('rejects invalid credentials and does not create a user', async () => {
    await expect(
      startDevelopmentLogin({
        config: devConfig(),
        audience: 'app',
        client: 'web',
        email: APP_EMAIL,
        password: 'wrong-password',
        ip: '203.0.113.11',
      }),
    ).rejects.toMatchObject({ status: 401, code: 'auth/invalid-credentials' });
    expect(await mongoose.connection.collection('users').countDocuments({})).toBe(0);
    expect(await OtpChallengeModel.countDocuments({})).toBe(0);
  });

  it('rejects an incorrect, expired, reused, or superseded code', async () => {
    const config = devConfig();
    const started = await startDevelopmentLogin({
      config,
      audience: 'app',
      client: 'web',
      email: APP_EMAIL,
      password: APP_PASSWORD,
      ip: '203.0.113.12',
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    await expect(
      verifyAppDevelopmentLogin({
        config,
        client: 'web',
        challengeId: started.challengeId,
        code: '590317',
        now: new Date('2026-01-01T00:00:01.000Z'),
      }),
    ).rejects.toMatchObject({ status: 422, code: 'auth/otp-incorrect' });

    const expired = await startDevelopmentLogin({
      config,
      audience: 'app',
      client: 'web',
      email: APP_EMAIL,
      password: APP_PASSWORD,
      ip: '203.0.113.12',
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    await expect(
      verifyAppDevelopmentLogin({
        config,
        client: 'web',
        challengeId: expired.challengeId,
        code: APP_OTP,
        now: new Date('2026-01-01T00:02:01.000Z'),
      }),
    ).rejects.toMatchObject({ status: 401, code: 'auth/otp-expired' });

    const live = await startDevelopmentLogin({
      config,
      audience: 'app',
      client: 'web',
      email: APP_EMAIL,
      password: APP_PASSWORD,
      ip: '203.0.113.13',
    });
    await verifyAppDevelopmentLogin({
      config,
      client: 'web',
      challengeId: live.challengeId,
      code: APP_OTP,
    });
    await expect(
      verifyAppDevelopmentLogin({
        config,
        client: 'web',
        challengeId: live.challengeId,
        code: APP_OTP,
      }),
    ).rejects.toMatchObject({ status: 401, code: 'auth/invalid-credentials' });

    const first = await startDevelopmentLogin({
      config,
      audience: 'app',
      client: 'mobile',
      email: APP_EMAIL,
      password: APP_PASSWORD,
      ip: '203.0.113.14',
    });
    const second = await startDevelopmentLogin({
      config,
      audience: 'app',
      client: 'mobile',
      email: APP_EMAIL,
      password: APP_PASSWORD,
      ip: '203.0.113.14',
    });
    await expect(
      verifyAppDevelopmentLogin({
        config,
        client: 'mobile',
        challengeId: first.challengeId,
        code: APP_OTP,
      }),
    ).rejects.toBeTruthy();
    const mobile = await verifyAppDevelopmentLogin({
      config,
      client: 'mobile',
      challengeId: second.challengeId,
      code: APP_OTP,
    });
    expect(mobile.tokens.accessToken).toBeTruthy();
    expect(mobile.user.id).toBeTruthy();
  });

  it('locks a challenge after too many wrong codes and rate-limits credential attempts', async () => {
    const config = devConfig({ maxCredentialAttempts: 2, maxOtpAttempts: 3 });
    const started = await startDevelopmentLogin({
      config,
      audience: 'admin',
      client: 'admin',
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      ip: '203.0.113.20',
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        verifyAdminDevelopmentLogin({
          config,
          challengeId: started.challengeId,
          code: '590317',
        }),
      ).rejects.toMatchObject({ code: 'auth/invalid-otp' });
    }
    await expect(
      verifyAdminDevelopmentLogin({ config, challengeId: started.challengeId, code: '590317' }),
    ).rejects.toMatchObject({ status: 423, code: 'auth/challenge-locked' });
    await expect(
      verifyAdminDevelopmentLogin({ config, challengeId: started.challengeId, code: ADMIN_OTP }),
    ).rejects.toMatchObject({ status: 423, code: 'auth/challenge-locked' });

    const ip = '203.0.113.21';
    const now = new Date('2026-02-01T00:00:00.000Z');
    await expect(
      startDevelopmentLogin({
        config,
        audience: 'app',
        client: 'web',
        email: APP_EMAIL,
        password: 'wrong-password',
        ip,
        now,
      }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      startDevelopmentLogin({
        config,
        audience: 'app',
        client: 'web',
        email: APP_EMAIL,
        password: 'wrong-password',
        ip,
        now: new Date(now.getTime() + 1000),
      }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      startDevelopmentLogin({
        config,
        audience: 'app',
        client: 'web',
        email: APP_EMAIL,
        password: APP_PASSWORD,
        ip,
        now: new Date(now.getTime() + 2000),
      }),
    ).rejects.toMatchObject({ status: 429, code: 'auth/dev-login-rate-limited' });
  });

  it('stays off when disabled or when NODE_ENV is production', async () => {
    await expect(
      startDevelopmentLogin({
        config: devConfig({ enabled: false, app: null, admin: null }),
        audience: 'app',
        client: 'web',
        email: APP_EMAIL,
        password: APP_PASSWORD,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'auth/dev-login-disabled' });
    await expect(
      startDevelopmentLogin({
        config: devConfig({ nodeEnv: 'production' }),
        audience: 'admin',
        client: 'admin',
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'auth/dev-login-disabled' });
    expect(await OtpChallengeModel.countDocuments({})).toBe(0);
  });

  it('does not take over an existing customer or grant admin to application credentials', async () => {
    const existing = await userRepository.create({
      email: APP_EMAIL,
      roles: ['seller'],
      profile: { fullName: 'Real Customer' },
    });
    await expect(
      startDevelopmentLogin({
        config: devConfig(),
        audience: 'app',
        client: 'web',
        email: APP_EMAIL,
        password: APP_PASSWORD,
        ip: '203.0.113.30',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'auth/dev-login-conflict' });
    const after = await userRepository.findById(existing.id);
    expect(after?.roles).toEqual(['seller']);
    expect(after?.profile.fullName).toBe('Real Customer');

    await expect(
      startDevelopmentLogin({
        config: devConfig(),
        audience: 'admin',
        client: 'admin',
        email: APP_EMAIL,
        password: APP_PASSWORD,
        ip: '203.0.113.31',
      }),
    ).rejects.toMatchObject({ status: 401, code: 'auth/invalid-credentials' });
    expect(await findStaffByEmail(APP_EMAIL)).toBeNull();
  });

  it('gives the admin developer only the configured permissions and leaves other staff alone', async () => {
    const ceo = await createStaff({
      email: 'ceo@mineralbridge.co.ke',
      password: 'Correct-Horse-9!Battery',
      name: 'Platform CEO',
      roleId: 'ROLE-CEO',
    });
    await expect(
      startDevelopmentLogin({
        config: devConfig(),
        audience: 'admin',
        client: 'admin',
        email: 'ceo@mineralbridge.co.ke',
        password: ADMIN_PASSWORD,
        ip: '203.0.113.40',
      }),
    ).rejects.toMatchObject({ status: 401, code: 'auth/invalid-credentials' });

    const started = await startDevelopmentLogin({
      config: devConfig(),
      audience: 'admin',
      client: 'admin',
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      ip: '203.0.113.41',
    });
    const { staff } = await verifyAdminDevelopmentLogin({
      config: devConfig(),
      challengeId: started.challengeId,
      code: ADMIN_OTP,
    });
    expect(staff.role.id).toBe('ROLE-DEV');
    expect(staff.permissions.orders).toBe('view');
    expect(staff.permissions.settings).toBe('none');
    expect(staff.permissions.financial).toBe('none');
    const untouched = await findStaffByEmail(ceo.email);
    expect(untouched?.role.id).toBe('ROLE-CEO');
    expect(untouched?.permissions.settings).toBe('edit');
  });

  it('does not let the normal OTP endpoints consume a development challenge', async () => {
    const mail = new FakeEmailProvider();
    setEmailProvider(mail);
    const started = await startDevelopmentLogin({
      config: devConfig(),
      audience: 'app',
      client: 'web',
      email: APP_EMAIL,
      password: APP_PASSWORD,
      ip: '203.0.113.50',
    });
    await expect(
      verifyWebOtp({ challengeId: started.challengeId, code: APP_OTP, device: {} }),
    ).rejects.toMatchObject({ code: 'auth/invalid-credentials' });
    await expect(resendWebOtp({ challengeId: started.challengeId })).rejects.toBeTruthy();
    expect(mail.outbox).toHaveLength(0);
    const session = await verifyAppDevelopmentLogin({
      config: devConfig(),
      client: 'web',
      challengeId: started.challengeId,
      code: APP_OTP,
    });
    expect(session.tokens.accessToken).toBeTruthy();
  });
});

describe('development login routes', () => {
  const envKeys = [
    'NODE_ENV',
    'DEV_LOGIN_ENABLED',
    'DEV_LOGIN_EMAIL',
    'DEV_LOGIN_PASSWORD',
    'DEV_LOGIN_OTP',
    'DEV_ADMIN_LOGIN_EMAIL',
    'DEV_ADMIN_LOGIN_PASSWORD',
    'DEV_ADMIN_LOGIN_OTP',
    'DEV_ADMIN_PERMISSIONS',
    'DEV_LOGIN_OTP_TTL_SECONDS',
    'DEV_LOGIN_MAX_CREDENTIAL_ATTEMPTS',
    'JWT_ACCESS_SECRET',
    'JWT_REFRESH_SECRET',
    'ADMIN_SESSION_SECRET',
    'WS_TOKEN_SECRET',
    'AUTH_RATE_LIMIT_MAX',
    'COOKIE_SECURE',
    'WEB_REFRESH_COOKIE_NAME',
    'ADMIN_SESSION_COOKIE_NAME',
  ] as const;
  const saved = new Map<string, string | undefined>();

  function useEnv(nodeEnv: 'development' | 'production' | 'test', enabled: boolean): void {
    process.env.NODE_ENV = nodeEnv;
    process.env.DEV_LOGIN_ENABLED = enabled ? 'true' : 'false';
    process.env.DEV_LOGIN_EMAIL = APP_EMAIL;
    process.env.DEV_LOGIN_PASSWORD = APP_PASSWORD;
    process.env.DEV_LOGIN_OTP = APP_OTP;
    process.env.DEV_ADMIN_LOGIN_EMAIL = ADMIN_EMAIL;
    process.env.DEV_ADMIN_LOGIN_PASSWORD = ADMIN_PASSWORD;
    process.env.DEV_ADMIN_LOGIN_OTP = ADMIN_OTP;
    process.env.DEV_ADMIN_PERMISSIONS = 'orders:view';
    process.env.DEV_LOGIN_OTP_TTL_SECONDS = '120';
    process.env.DEV_LOGIN_MAX_CREDENTIAL_ATTEMPTS = '5';
    process.env.AUTH_RATE_LIMIT_MAX = '1000';
    process.env.COOKIE_SECURE = 'false';
    process.env.WEB_REFRESH_COOKIE_NAME = 'mb_refresh';
    process.env.ADMIN_SESSION_COOKIE_NAME = 'mb_admin_session';
    process.env.JWT_ACCESS_SECRET ||= 'test-access-secret-min-32-characters!!';
    process.env.JWT_REFRESH_SECRET ||= 'test-refresh-secret-min-32-characters!';
    process.env.ADMIN_SESSION_SECRET ||= 'test-admin-session-secret-min-32!!';
    process.env.WS_TOKEN_SECRET ||= 'test-ws-token-secret-min-32-chars!!!!';
    resetEnvCache();
  }

  function customerApp(): Express {
    const app = express();
    app.use(requestContext);
    app.use(cookieParser());
    app.use(express.json());
    app.use('/v1', createCustomerAuthRouter());
    app.use(notFoundHandler);
    app.use(errorHandler);
    return app;
  }

  beforeEach(() => {
    for (const key of envKeys) saved.set(key, process.env[key]);
  });

  afterEach(() => {
    for (const key of envKeys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.env.NODE_ENV = 'test';
    resetEnvCache();
  });

  it('rejects the route in production and when the flag is off', async () => {
    useEnv('production', true);
    const production = await request(customerApp())
      .post('/v1/auth/dev-login')
      .send({ email: APP_EMAIL, password: APP_PASSWORD, isAdmin: true, role: 'ROLE-CEO' });
    expect(production.status).toBe(404);
    expect(production.body.code).toBe('auth/dev-login-disabled');
    expect(production.body.developmentOtp).toBeUndefined();

    useEnv('development', false);
    const disabled = await request(customerApp()).get('/v1/auth/dev-login');
    expect(disabled.status).toBe(200);
    expect(disabled.body).toEqual({ enabled: false });
  });

  it('signs in the web and mobile clients through the backend and ignores a client role', async () => {
    useEnv('development', true);
    const app = customerApp();
    const status = await request(app).get('/v1/auth/dev-login');
    expect(status.body.enabled).toBe(true);

    const webStart = await request(app)
      .post('/v1/auth/dev-login')
      .send({ email: APP_EMAIL, password: APP_PASSWORD, isAdmin: true, role: 'ROLE-CEO' });
    expect(webStart.status).toBe(200);
    expect(webStart.body.developmentOtp).toBe(APP_OTP);
    const web = await request(app).post('/v1/auth/dev-login/verify').send({
      challengeId: webStart.body.challengeId,
      code: webStart.body.developmentOtp,
    });
    expect(web.status).toBe(200);
    expect(web.body.user.role).toBe('buyer');
    expect(web.body.developmentOtp).toBeUndefined();
    const setCookie = web.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie ?? '');
    expect(cookieHeader).toContain('mb_refresh');
    const claims = verifyAccessToken(web.body.accessToken as string);
    expect(claims.ok && claims.claims.roles).toEqual(['buyer']);

    const mobileStart = await request(app)
      .post('/v1/auth/dev-login')
      .set('X-Client', 'mineralbridge-mobile/0.0.1')
      .send({ email: APP_EMAIL, password: APP_PASSWORD });
    const mobile = await request(app)
      .post('/v1/auth/dev-login/verify')
      .set('X-Client', 'mineralbridge-mobile/0.0.1')
      .send({ challengeId: mobileStart.body.challengeId, code: mobileStart.body.developmentOtp });
    expect(mobile.status).toBe(200);
    expect(mobile.body.refreshToken).toBeTruthy();
    expect(mobile.body.account.kyc.status).toBe('none');
  });

  it('keeps the admin route guard on the development session', async () => {
    useEnv('development', true);
    const app = buildAdminApp();
    const agent = request.agent(app);
    const started = await agent.post('/admin/v1/auth/dev-login').send({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      isAdmin: true,
    });
    expect(started.status).toBe(200);
    expect(started.body.developmentOtp).toBe(ADMIN_OTP);
    const verified = await agent
      .post('/admin/v1/auth/dev-login/verify')
      .send({ challengeId: started.body.challengeId, code: started.body.developmentOtp });
    expect(verified.status).toBe(200);
    expect(verified.body.me.role.id).toBe('ROLE-DEV');
    expect(verified.body.me.permissions.settings).toBe('none');
    expect(verified.body.me.permissions.orders).toBe('view');

    const me = await agent.get('/admin/v1/me');
    expect(me.status).toBe(200);
    const denied = await agent.get('/admin/v1/settings/platform');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('auth/forbidden');

    const appCredentials = await agent
      .post('/admin/v1/auth/dev-login')
      .send({ email: APP_EMAIL, password: APP_PASSWORD, role: 'ROLE-CEO' });
    expect(appCredentials.status).toBe(401);
    expect(appCredentials.body.developmentOtp).toBeUndefined();
  });
});

describe('development login source', () => {
  it('does not embed a developer password or a fixed code', () => {
    const source = readFileSync(new URL('../src/modules/auth/dev-login.service.ts', import.meta.url), 'utf8');
    expect(source).not.toContain(APP_PASSWORD);
    expect(source).not.toContain(ADMIN_PASSWORD);
    expect(source).not.toContain(APP_OTP);
    expect(source).not.toContain('123456');
  });
});
