import { describe, expect, it } from 'vitest';
import { resolveEmailProviderName, resolveOtpProviderName } from '../src/config/env.js';

describe('provider selection from existing credentials', () => {
  it('keeps an explicit provider even when other credentials exist', () => {
    expect(resolveOtpProviderName({ OTP_PROVIDER: 'fake', SMS_VENDOR_URL: 'http://sms.example/send' })).toBe('fake');
    expect(resolveEmailProviderName({ EMAIL_PROVIDER: 'smtp', RESEND_API_KEY: 're_test' })).toBe('smtp');
  });

  it('uses SpearUC when the vendor URL is set and OTP_PROVIDER is absent', () => {
    expect(resolveOtpProviderName({ SMS_VENDOR_URL: 'http://sms.example/send?user=a' })).toBe('spearuc');
  });

  it('uses Twilio only when the account, token, and a from-number are all set', () => {
    expect(
      resolveOtpProviderName({
        TWILIO_ACCOUNT_SID: 'AC1',
        TWILIO_AUTH_TOKEN: 'token',
        TWILIO_SMS_FROM: '+15550001111',
      }),
    ).toBe('twilio');
    expect(resolveOtpProviderName({ TWILIO_ACCOUNT_SID: 'AC1' })).toBe('fake');
  });

  it('uses Resend when the API key is set and EMAIL_PROVIDER is absent', () => {
    expect(resolveEmailProviderName({ RESEND_API_KEY: 're_test' })).toBe('resend');
    expect(resolveEmailProviderName({})).toBe('fake');
  });
});
