import { AppError } from '../errors/app-error.js';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';

export type SentSms = { to: string; text: string; at: Date };

/** Dev/test inbox for the `fake` provider (never populated in production). */
export const fakeSmsOutbox: SentSms[] = [];

function unavailable(code: string, message: string): AppError {
  return new AppError({ status: 503, code, message });
}

/**
 * Sends one SMS (OTP and staff→customer messages).
 *  - fake: development/test only. Refuses in production so a misconfigured deploy fails loudly.
 *  - twilio: REST call using TWILIO_* env.
 *  - africastalking: not bundled → 503.
 */
export async function sendSms(to: string, text: string): Promise<void> {
  const env = loadEnv();
  if (env.OTP_PROVIDER === 'fake') {
    if (env.NODE_ENV === 'production') {
      throw unavailable('sms/provider-unconfigured', 'SMS provider is not configured (OTP_PROVIDER=fake is not allowed in production)');
    }
    fakeSmsOutbox.push({ to, text, at: new Date() });
    if (fakeSmsOutbox.length > 200) fakeSmsOutbox.shift();
    if (env.NODE_ENV === 'development') logger.info({ to, text }, '[fake-sms]');
    return;
  }
  if (env.OTP_PROVIDER === 'twilio') {
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_NUMBER) {
      throw unavailable('sms/provider-unconfigured', 'Twilio credentials are not configured');
    }
    const body = new URLSearchParams({ To: to, From: env.TWILIO_FROM_NUMBER, Body: text });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    }).catch((err: unknown) => {
      logger.error({ err }, 'Twilio request failed');
      throw unavailable('sms/provider-down', 'SMS provider is unreachable');
    });
    if (!res.ok) {
      logger.error({ status: res.status }, 'Twilio rejected message');
      throw unavailable('sms/provider-error', 'SMS provider rejected the message');
    }
    return;
  }
  throw unavailable('sms/provider-unconfigured', `SMS provider "${env.OTP_PROVIDER}" is not available in this build`);
}

export function maskPhone(phone: string | undefined | null): string {
  if (!phone) return '—';
  const digits = phone.replace(/\s+/g, '');
  if (digits.length < 7) return '••••';
  return `${digits.slice(0, 4)} ${digits.slice(4, 7)} •• ${digits.slice(-4)}`;
}
