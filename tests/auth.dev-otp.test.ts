import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { resetEnvCache } from '../src/config/env.js';
import { FakeEmailProvider, setEmailProvider, type EmailProvider } from '../src/integrations/email/email.provider.js';
import { setOtpProvider } from '../src/integrations/otp/otp.provider.js';
import { registerWeb, requestWebOtp, verifyWebOtp } from '../src/modules/auth/auth.service.js';
import { OtpChallengeModel, OtpSendLogModel } from '../src/modules/auth/otp.model.js';
import { requestChallenge, verifyChallenge } from '../src/modules/auth/otp.service.js';
import { useMemoryMongo } from './setup.js';

useMemoryMongo('auth_dev_otp');

const email = 'dev-otp@example.com';
const phone = '+2348099900011';

beforeAll(async () => {
  await connectDatabase(process.env.MONGODB_URI);
}, 120_000);

afterAll(async () => {
  await disconnectDatabase();
});

afterEach(async () => {
  setOtpProvider(null);
  setEmailProvider(null);
  process.env.NODE_ENV = 'test';
  delete process.env.DEV_OTP_ENABLED;
  resetEnvCache();
  await OtpChallengeModel.deleteMany({});
  await OtpSendLogModel.deleteMany({});
  await mongoose.connection.collection('users').deleteMany({});
});

function enableDevelopmentOtp(): void {
  process.env.NODE_ENV = 'development';
  process.env.DEV_OTP_ENABLED = 'true';
  resetEnvCache();
}

function throwingEmail(): EmailProvider {
  return {
    name: 'email',
    async send() {
      throw new Error('email must not be called');
    },
  };
}

describe('development OTP delivery', () => {
  it('returns a local email code and does not call the email provider', async () => {
    enableDevelopmentOtp();
    const mail = new FakeEmailProvider();
    setEmailProvider(mail);
    const info = await registerWeb({
      registration: {
        method: 'email',
        identifier: email,
        email,
        fullName: 'Ada Lovelace',
        role: 'buyer',
        country: 'ZA',
        acceptedTermsVersion: '1',
      },
    });
    expect(info.developmentOtp).toMatch(/^\d{4}$/);
    expect(info.codeLength).toBe(4);
    expect(mail.outbox).toHaveLength(0);
    expect(await mongoose.connection.collection('users').countDocuments({ email })).toBe(0);
    const created = await verifyWebOtp({ challengeId: info.challengeId, code: info.developmentOtp!, device: {} });
    expect(created.isNewAccount).toBe(true);
    expect(created.user.email).toBe(email);
    expect(created.user.profile.fullName).toBe('Ada Lovelace');
  });

  it('returns a local SMS code and does not call the SMS provider', async () => {
    enableDevelopmentOtp();
    const calls: string[] = [];
    setOtpProvider({
      name: 'guard',
      async send() {
        calls.push('sms');
        throw new Error('sms must not be called');
      },
    });
    const info = await requestChallenge({
      client: 'web',
      intent: 'signup',
      channel: 'sms',
      destination: phone,
      payload: { registration: { method: 'mobile', identifier: phone } },
    });
    expect(info.developmentOtp).toMatch(/^\d{4}$/);
    expect(calls).toHaveLength(0);
    const verified = await verifyChallenge({
      challengeId: info.challengeId,
      code: info.developmentOtp!,
      client: 'web',
      destination: phone,
    });
    expect(verified.destination).toBe(phone);
    expect(verified.intent).toBe('signup');
  });

  it('rejects a wrong, expired, reused, or mismatched code', async () => {
    enableDevelopmentOtp();
    setEmailProvider(throwingEmail());
    const info = await requestChallenge({
      client: 'web',
      intent: 'login',
      channel: 'email',
      destination: email,
      subject: { type: 'user', id: 'user-1' },
    });
    await expect(
      verifyChallenge({ challengeId: info.challengeId, code: '000000', client: 'web', destination: email }),
    ).rejects.toMatchObject({ code: 'auth/otp-incorrect' });
    await expect(
      verifyChallenge({ challengeId: info.challengeId, code: info.developmentOtp!, client: 'web', destination: 'other@example.com' }),
    ).rejects.toMatchObject({ code: 'auth/otp-incorrect' });
    await OtpChallengeModel.updateOne({ challengeId: info.challengeId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(
      verifyChallenge({ challengeId: info.challengeId, code: info.developmentOtp!, client: 'web' }),
    ).rejects.toMatchObject({ code: 'auth/otp-expired' });

    const fresh = await requestChallenge({
      client: 'mobile',
      intent: 'signup',
      channel: 'sms',
      destination: phone,
    });
    await verifyChallenge({ challengeId: fresh.challengeId, code: fresh.developmentOtp!, client: 'mobile', destination: phone });
    await expect(
      verifyChallenge({ challengeId: fresh.challengeId, code: fresh.developmentOtp!, client: 'mobile', destination: phone }),
    ).rejects.toMatchObject({ status: 410 });
  });

  it('does not let one contact or purpose verify another', async () => {
    enableDevelopmentOtp();
    setEmailProvider(throwingEmail());
    const signup = await requestChallenge({ client: 'web', intent: 'signup', channel: 'email', destination: email });
    const login = await requestChallenge({ client: 'web', intent: 'login', channel: 'email', destination: 'other@example.com' });
    await expect(
      verifyChallenge({ challengeId: login.challengeId, code: signup.developmentOtp!, client: 'web' }),
    ).rejects.toMatchObject({ code: 'auth/otp-incorrect' });
  });

  it('rejects a duplicate signup and still logs an existing account in', async () => {
    enableDevelopmentOtp();
    setEmailProvider(throwingEmail());
    const first = await registerWeb({
      registration: {
        method: 'email',
        identifier: email,
        email,
        fullName: 'Ada Lovelace',
        role: 'buyer',
        country: 'ZA',
        acceptedTermsVersion: '1',
      },
    });
    await verifyWebOtp({ challengeId: first.challengeId, code: first.developmentOtp!, device: {} });
    await expect(
      registerWeb({
        registration: {
          method: 'email',
          identifier: email,
          email,
          fullName: 'Ada Lovelace',
          role: 'buyer',
          country: 'ZA',
          acceptedTermsVersion: '1',
        },
      }),
    ).rejects.toMatchObject({ code: 'auth/duplicate-email' });
    expect(await mongoose.connection.collection('users').countDocuments({ email })).toBe(1);
    const login = await requestWebOtp({ method: 'email', identifier: email, intent: 'login' });
    const session = await verifyWebOtp({ challengeId: login.challengeId, code: login.developmentOtp!, device: {} });
    expect(session.isNewAccount).toBe(false);
    await expect(
      requestWebOtp({ method: 'email', identifier: 'missing@example.com', intent: 'login' }),
    ).rejects.toMatchObject({ code: 'auth/account-not-found' });
  });

  it('omits the code in production even when the flag is set', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DEV_OTP_ENABLED = 'true';
    resetEnvCache();
    const mail = new FakeEmailProvider();
    setEmailProvider(mail);
    const info = await requestChallenge({ client: 'web', intent: 'signup', channel: 'email', destination: email });
    expect(info.developmentOtp).toBeUndefined();
    expect(info.codeLength).toBe(4);
    expect(mail.outbox).toHaveLength(1);
  });

  it('does not keep a send slot when the provider rejects the message', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.DEV_OTP_ENABLED;
    resetEnvCache();
    setEmailProvider({
      name: 'rejecting',
      async send() {
        throw Object.assign(new Error('rejected'), { status: 503, code: 'email/provider-unavailable' });
      },
    });
    await expect(
      requestChallenge({ client: 'web', intent: 'signup', channel: 'email', destination: email }),
    ).rejects.toThrow(/rejected/);
    expect(await OtpSendLogModel.countDocuments({})).toBe(0);
    expect(await OtpChallengeModel.countDocuments({})).toBe(0);
  });
});
