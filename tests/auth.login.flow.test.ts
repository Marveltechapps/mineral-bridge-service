import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../src/common/errors/app-error.js';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { FakeEmailProvider, setEmailProvider } from '../src/integrations/email/email.provider.js';
import {
  FakeOtpProvider,
  SMS_NUMBER_REJECTED_MESSAGE,
  setOtpProvider,
  type OtpProvider,
} from '../src/integrations/otp/otp.provider.js';
import {
  ACCOUNT_NOT_FOUND_MESSAGE,
  registerWeb,
  requestMobileOtp,
  requestWebOtp,
  verifyMobileOtp,
  verifyWebOtp,
} from '../src/modules/auth/auth.service.js';
import { OtpChallengeModel } from '../src/modules/auth/otp.model.js';
import { useMemoryMongo } from './setup.js';

useMemoryMongo('auth_login_flow');

const phone = '+2348012345678';
const email = 'login-flow@example.com';

beforeAll(async () => {
  await connectDatabase(process.env.MONGODB_URI);
}, 120_000);

afterAll(async () => {
  await disconnectDatabase();
});

afterEach(async () => {
  setOtpProvider(null);
  setEmailProvider(null);
  await OtpChallengeModel.deleteMany({});
  await mongoose.connection.collection('users').deleteMany({});
});

function codeFrom(text: string | undefined, digits: number): string {
  const match = text?.match(new RegExp(`\\d{${digits}}`));
  if (!match) throw new Error('provider did not capture a code');
  return match[0];
}

describe('customer login and registration verification', () => {
  it('rejects an unknown web login and does not send a code', async () => {
    const mail = new FakeEmailProvider();
    setEmailProvider(mail);
    await expect(
      requestWebOtp({ method: 'email', identifier: 'missing@example.com', intent: 'login' }),
    ).rejects.toMatchObject({
      status: 404,
      code: 'auth/account-not-found',
      message: ACCOUNT_NOT_FOUND_MESSAGE,
    });
    expect(mail.outbox).toHaveLength(0);
    expect(await OtpChallengeModel.countDocuments({})).toBe(0);
  });

  it('signs in an existing account and rejects a wrong code', async () => {
    const mail = new FakeEmailProvider();
    setEmailProvider(mail);
    const registered = await registerWeb({
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
    const created = await verifyWebOtp({
      challengeId: registered.challengeId,
      code: codeFrom(mail.lastTo(email)?.text, 4),
      device: {},
    });
    expect(created.isNewAccount).toBe(true);
    expect(created.user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(created.user.phoneVerifiedAt).toBeUndefined();

    mail.clear();
    const login = await requestWebOtp({ method: 'email', identifier: email, intent: 'login' });
    await expect(
      verifyWebOtp({ challengeId: login.challengeId, code: '0000', device: {} }),
    ).rejects.toMatchObject({ code: 'auth/otp-incorrect' });
    const session = await verifyWebOtp({
      challengeId: login.challengeId,
      code: codeFrom(mail.lastTo(email)?.text, 4),
      device: {},
    });
    expect(session.isNewAccount).toBe(false);
    expect(session.user.id).toBe(created.user.id);
    expect(session.tokens.accessToken).toBeTruthy();
  });

  it('rejects a duplicate email or mobile before creating another account', async () => {
    const mail = new FakeEmailProvider();
    setEmailProvider(mail);
    const sms = new FakeOtpProvider();
    setOtpProvider(sms);
    const payload = {
      method: 'email' as const,
      identifier: email,
      email,
      phone: '+27821234567',
      fullName: 'Ada Lovelace',
      role: 'buyer' as const,
      country: 'ZA',
      acceptedTermsVersion: '1',
    };
    const first = await registerWeb({ registration: payload });
    await verifyWebOtp({
      challengeId: first.challengeId,
      code: codeFrom(mail.lastTo(email)?.text, 4),
      device: {},
    });
    await expect(registerWeb({ registration: payload })).rejects.toMatchObject({ code: 'auth/duplicate-email' });
    await expect(
      registerWeb({
        registration: {
          ...payload,
          method: 'mobile',
          identifier: '+27821234567',
          email: 'other@example.com',
        },
      }),
    ).rejects.toMatchObject({ code: 'auth/duplicate-mobile' });
    expect(await mongoose.connection.collection('users').countDocuments({})).toBe(1);
  });

  it('verifies only the channel the person chose', async () => {
    const sms = new FakeOtpProvider();
    setOtpProvider(sms);
    const info = await registerWeb({
      registration: {
        method: 'mobile',
        identifier: '+27821234567',
        phone: '+27821234567',
        email: 'channel@example.com',
        fullName: 'Ada Lovelace',
        role: 'seller',
        country: 'ZA',
        acceptedTermsVersion: '1',
      },
    });
    const session = await verifyWebOtp({
      challengeId: info.challengeId,
      code: sms.lastCodeFor('+27821234567')!,
      device: {},
    });
    expect(session.user.phoneVerifiedAt).toBeInstanceOf(Date);
    expect(session.user.email).toBe('channel@example.com');
    expect(session.user.emailVerifiedAt).toBeUndefined();
  });

  it('keeps the registration unsent when SMS is rejected so email can be chosen instead', async () => {
    const sms: OtpProvider = {
      name: 'restricted',
      async send() {
        throw new AppError({ status: 422, code: 'auth/invalid-phone', message: SMS_NUMBER_REJECTED_MESSAGE });
      },
    };
    setOtpProvider(sms);
    const mail = new FakeEmailProvider();
    setEmailProvider(mail);
    await expect(
      registerWeb({
        registration: {
          method: 'mobile',
          identifier: '+27821234567',
          phone: '+27821234567',
          email: 'fallback@example.com',
          fullName: 'Ada Lovelace',
          role: 'buyer',
          country: 'ZA',
          acceptedTermsVersion: '1',
        },
      }),
    ).rejects.toMatchObject({ code: 'auth/invalid-phone', message: SMS_NUMBER_REJECTED_MESSAGE });
    expect(await mongoose.connection.collection('users').countDocuments({})).toBe(0);

    const emailChallenge = await registerWeb({
      registration: {
        method: 'email',
        identifier: 'fallback@example.com',
        email: 'fallback@example.com',
        phone: '+27821234567',
        fullName: 'Ada Lovelace',
        role: 'buyer',
        country: 'ZA',
        acceptedTermsVersion: '1',
      },
    });
    const session = await verifyWebOtp({
      challengeId: emailChallenge.challengeId,
      code: codeFrom(mail.lastTo('fallback@example.com')?.text, 4),
      device: {},
    });
    expect(session.isNewAccount).toBe(true);
    expect(session.user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(session.user.phoneVerifiedAt).toBeUndefined();
  });

  it('does not create a mobile account when login is attempted for an unknown number', async () => {
    const sms = new FakeOtpProvider();
    setOtpProvider(sms);
    await expect(requestMobileOtp({ phone, intent: 'login', channel: 'sms' })).rejects.toMatchObject({
      code: 'auth/account-not-found',
      message: ACCOUNT_NOT_FOUND_MESSAGE,
    });
    expect(sms.sent).toHaveLength(0);

    const signup = await requestMobileOtp({ phone, intent: 'signup', channel: 'sms' });
    const created = await verifyMobileOtp({
      challengeId: signup.challengeId,
      phone,
      code: sms.lastCodeFor(phone)!,
      device: {},
    });
    expect(created.isNewAccount).toBe(true);

    const login = await requestMobileOtp({ phone, intent: 'login', channel: 'sms' });
    await expect(
      verifyMobileOtp({ challengeId: login.challengeId, phone, code: '0000', device: {} }),
    ).rejects.toMatchObject({ code: 'auth/otp-invalid' });
  });

  it('rejects a second mobile sign-up for a number that already has an account', async () => {
    const sms = new FakeOtpProvider();
    setOtpProvider(sms);
    const signup = await requestMobileOtp({ phone: '+2348099990000', intent: 'signup', channel: 'sms' });
    await verifyMobileOtp({
      challengeId: signup.challengeId,
      phone: '+2348099990000',
      code: sms.lastCodeFor('+2348099990000')!,
      device: {},
    });
    await expect(
      requestMobileOtp({ phone: '+2348099990000', intent: 'signup', channel: 'sms' }),
    ).rejects.toMatchObject({ code: 'auth/duplicate-mobile' });
    expect(await mongoose.connection.collection('users').countDocuments({ phone: '+2348099990000' })).toBe(1);
  });
});
