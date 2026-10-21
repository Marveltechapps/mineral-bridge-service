import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../src/common/errors/app-error.js';
import { FakeEmailProvider, setEmailProvider } from '../src/integrations/email/email.provider.js';
import { FakeOtpProvider, setOtpProvider, type OtpProvider } from '../src/integrations/otp/otp.provider.js';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { requestChallenge, resendChallenge, verifyChallenge } from '../src/modules/auth/otp.service.js';
import { OtpChallengeModel } from '../src/modules/auth/otp.model.js';
import { findOrCreateFromWebRegistration } from '../src/modules/users/user.service.js';
import { useMemoryMongo } from './setup.js';

useMemoryMongo('auth_otp_flow');

const phone = '+2348011111111';
const email = 'otp-flow@example.com';

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
});

function failingProvider(): OtpProvider {
  return {
    name: 'failing',
    async send() {
      throw new AppError({
        status: 503,
        code: 'otp/provider-unavailable',
        message: 'Verification codes cannot be sent right now. Please try again shortly.',
      });
    },
  };
}

describe('OTP request, verify, expiry, and resend', () => {
  it('verifies a code once and rejects reuse, a wrong code, and an expired code', async () => {
    const otp = new FakeOtpProvider();
    setOtpProvider(otp);
    const now = new Date('2026-10-17T12:00:00.000Z');
    const info = await requestChallenge({
      client: 'mobile',
      intent: 'signup',
      channel: 'sms',
      destination: phone,
      now,
    });
    const code = otp.lastCodeFor(phone);
    expect(code).toMatch(/^\d{6}$/);
    expect(JSON.stringify(info)).not.toContain(code);

    await expect(
      verifyChallenge({ challengeId: info.challengeId, code: '000000', client: 'mobile', destination: phone, now }),
    ).rejects.toMatchObject({ code: 'auth/otp-invalid' });

    const verified = await verifyChallenge({
      challengeId: info.challengeId,
      code: code!,
      client: 'mobile',
      destination: phone,
      now,
    });
    expect(verified.consumedAt).toBeInstanceOf(Date);

    await expect(
      verifyChallenge({ challengeId: info.challengeId, code: code!, client: 'mobile', destination: phone, now }),
    ).rejects.toMatchObject({ code: 'auth/otp-expired' });

    const second = await requestChallenge({
      client: 'mobile',
      intent: 'login',
      channel: 'sms',
      destination: '+2348022222222',
      now,
    });
    await expect(
      verifyChallenge({
        challengeId: second.challengeId,
        code: otp.lastCodeFor('+2348022222222')!,
        client: 'mobile',
        destination: '+2348022222222',
        now: new Date(now.getTime() + 120_000),
      }),
    ).rejects.toMatchObject({ code: 'auth/otp-expired' });
  });

  it('keeps the previous code when a resend is rejected by the provider', async () => {
    const otp = new FakeOtpProvider();
    setOtpProvider(otp);
    const now = new Date('2026-10-17T12:00:00.000Z');
    const info = await requestChallenge({
      client: 'mobile',
      intent: 'login',
      channel: 'sms',
      destination: phone,
      now,
    });
    const code = otp.lastCodeFor(phone)!;
    setOtpProvider(failingProvider());

    await expect(
      resendChallenge({
        challengeId: info.challengeId,
        client: 'mobile',
        now: new Date(now.getTime() + 45_000),
      }),
    ).rejects.toMatchObject({ status: 503, code: 'otp/provider-unavailable' });

    const verified = await verifyChallenge({
      challengeId: info.challengeId,
      code,
      client: 'mobile',
      destination: phone,
      now: new Date(now.getTime() + 10_000),
    });
    expect(verified.consumedAt).toBeInstanceOf(Date);
  });

  it('does not leave an email challenge behind when the email provider rejects it', async () => {
    setEmailProvider({
      name: 'failing-email',
      async send() {
        throw new AppError({
          status: 503,
          code: 'email/provider-unavailable',
          message: "We couldn't send your verification code right now. Please try again or choose another verification method.",
        });
      },
    });
    await expect(
      requestChallenge({
        client: 'web',
        intent: 'signup',
        channel: 'email',
        destination: email,
      }),
    ).rejects.toMatchObject({ code: 'email/provider-unavailable' });
    expect(await OtpChallengeModel.countDocuments({ destination: email })).toBe(0);
  });

  it('sends an email code without putting the code in the challenge response', async () => {
    const mail = new FakeEmailProvider();
    setEmailProvider(mail);
    const info = await requestChallenge({
      client: 'web',
      intent: 'signup',
      channel: 'email',
      destination: email,
    });
    const sent = mail.lastTo(email);
    expect(sent?.subject).toMatch(/verification code/i);
    const code = sent?.text.match(/\d{4}/)?.[0];
    expect(code).toBeTruthy();
    expect(JSON.stringify(info)).not.toContain(code);
    await verifyChallenge({ challengeId: info.challengeId, code: code!, client: 'web' });
  });

  it('does not accept any code for a decoy login challenge', async () => {
    const info = await requestChallenge({
      client: 'web',
      intent: 'login',
      channel: 'email',
      destination: 'missing@example.com',
      decoy: true,
    });
    await expect(
      verifyChallenge({ challengeId: info.challengeId, code: '1234', client: 'web' }),
    ).rejects.toMatchObject({ code: 'auth/otp-incorrect' });
  });

  it('signs an existing web identifier into the same account instead of creating a duplicate', async () => {
    const payload = {
      method: 'email' as const,
      identifier: 'same@example.com',
      fullName: 'Same Person',
      role: 'buyer' as const,
      country: 'ZA',
      acceptedTermsVersion: '1',
      email: 'same@example.com',
    };
    const first = await findOrCreateFromWebRegistration(payload);
    const second = await findOrCreateFromWebRegistration(payload);
    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(second.user.id).toBe(first.user.id);
    expect(await mongoose.connection.collection('users').countDocuments({ email: 'same@example.com' })).toBe(1);
  });
});
