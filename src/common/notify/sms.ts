import { AppError } from '../errors/app-error.js';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { smsGatewayAccepted } from '../../integrations/otp/otp.provider.js';

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
    if (env.NODE_ENV === 'development') logger.info({ to }, '[fake-sms]');
    return;
  }
  if (env.OTP_PROVIDER === 'twilio') {
    const from = env.TWILIO_FROM_NUMBER || env.TWILIO_SMS_FROM;
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !from) {
      throw unavailable('sms/provider-unconfigured', 'Twilio credentials are not configured');
    }
    const body = new URLSearchParams({ To: to, From: from, Body: text });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: AbortSignal.timeout(10_000),
    }).catch((err: unknown) => {
      logger.error({ err: err instanceof Error ? err.name : 'error' }, 'Twilio request failed');
      throw unavailable('sms/provider-down', 'SMS provider is unreachable');
    });
    if (!res.ok) {
      logger.error({ status: res.status }, 'Twilio rejected message');
      throw unavailable('sms/provider-error', 'SMS provider rejected the message');
    }
    return;
  }
  if (env.OTP_PROVIDER === 'spearuc') {
    if (!env.SMS_VENDOR_URL) {
      throw unavailable('sms/provider-unconfigured', 'SMS gateway URL is not configured');
    }
    const url = new URL(env.SMS_VENDOR_URL);
    url.searchParams.set('mobile', to.replace(/^\+/, ''));
    url.searchParams.set('message', text);
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10_000) }).catch((err: unknown) => {
      logger.error({ err: err instanceof Error ? err.name : 'error' }, 'SMS gateway request failed');
      throw unavailable('sms/provider-down', 'SMS provider is unreachable');
    });
    const body = await res.text().catch(() => '');
    if (!smsGatewayAccepted(res.ok, body)) {
      logger.error({ status: res.status }, 'SMS gateway rejected message');
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
