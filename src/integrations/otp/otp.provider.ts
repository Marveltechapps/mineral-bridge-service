import { AppError } from '../../common/errors/app-error.js';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';

export type OtpDeliveryChannel = 'sms' | 'voice' | 'whatsapp';

export interface OtpSendRequest {
  /** E.164 destination. */
  to: string;
  /** Plaintext code. Only ever passed to the provider; never persisted or logged in production. */
  code: string;
  channel: OtpDeliveryChannel;
  ttlSeconds: number;
  locale?: string;
}

export interface OtpSendResult {
  providerMessageId?: string;
  /**
   * True only when the provider reported terminal delivery (handset or inbox).
   * A resolved `send()` means the provider accepted the request, which is not delivery.
   */
  delivered: boolean;
}

export interface OtpProvider {
  readonly name: string;
  send(request: OtpSendRequest): Promise<OtpSendResult>;
}

/**
 * In-memory provider for development and tests.
 *
 * `lastCodeFor` exists for TESTS ONLY. No API response, in any environment, ever carries
 * the code — the OTP service only hands it to `send()`. `createOtpProvider` refuses to build
 * this provider when NODE_ENV=production.
 */
export class FakeOtpProvider implements OtpProvider {
  readonly name = 'fake';
  private readonly codes = new Map<string, { code: string; channel: OtpDeliveryChannel; at: Date }>();
  readonly sent: Array<{ to: string; channel: OtpDeliveryChannel; at: Date }> = [];

  async send(request: OtpSendRequest): Promise<OtpSendResult> {
    const at = new Date();
    this.codes.set(request.to, { code: request.code, channel: request.channel, at });
    this.sent.push({ to: request.to, channel: request.channel, at });
    if (loadEnv().NODE_ENV === 'development') {
      logger.info({ to: request.to, channel: request.channel }, '[fake-otp] code captured for local development');
    }
    return { providerMessageId: `fake_${at.getTime()}`, delivered: false };
  }

  /** TEST ONLY. */
  lastCodeFor(destination: string): string | undefined {
    return this.codes.get(destination)?.code;
  }

  /** TEST ONLY. */
  clear(): void {
    this.codes.clear();
    this.sent.length = 0;
  }
}

export interface TwilioConfig {
  accountSid?: string;
  authToken?: string;
  fromNumber?: string;
}

/**
 * Twilio via the REST API (no SDK dependency). Without credentials it throws
 * `503 otp/provider-unavailable` on every send, so a misconfigured deployment fails loudly
 * instead of silently dropping codes.
 */
export class TwilioOtpProvider implements OtpProvider {
  readonly name = 'twilio';

  constructor(
    private readonly config: TwilioConfig & { whatsappFrom?: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private assertConfigured(): Required<TwilioConfig> & { whatsappFrom: string } {
    const { accountSid, authToken, fromNumber, whatsappFrom } = this.config;
    if (!accountSid || !authToken || !fromNumber) {
      throw new AppError({
        status: 503,
        code: 'otp/provider-unavailable',
        message: 'Verification codes cannot be sent right now. Please try again shortly.',
        // The real reason is operational detail — never shown to clients.
        details: undefined,
      });
    }
    return { accountSid, authToken, fromNumber, whatsappFrom: whatsappFrom || fromNumber };
  }

  async send(request: OtpSendRequest): Promise<OtpSendResult> {
    const { accountSid, authToken, fromNumber, whatsappFrom } = this.assertConfigured();
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const base = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}`;
    const body = new URLSearchParams();
    let url: string;

    if (request.channel === 'voice') {
      const spoken = request.code.split('').join(', ');
      url = `${base}/Calls.json`;
      body.set('To', request.to);
      body.set('From', fromNumber);
      body.set(
        'Twiml',
        `<Response><Say voice="alice" language="en-GB">Your Mineral Bridge verification code is ${spoken}. Again, ${spoken}.</Say></Response>`,
      );
    } else {
      url = `${base}/Messages.json`;
      const prefix = request.channel === 'whatsapp' ? 'whatsapp:' : '';
      const sender = request.channel === 'whatsapp' ? whatsappFrom : fromNumber;
      const normalizedFrom = sender.startsWith('whatsapp:') || prefix === '' ? sender : `${prefix}${sender}`;
      body.set('To', `${prefix}${request.to.replace(/^whatsapp:/, '')}`);
      body.set('From', normalizedFrom);
      body.set(
        'Body',
        `Your Mineral Bridge code is ${request.code}. It expires in ${Math.ceil(request.ttlSeconds / 60)} min. Never share it.`,
      );
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      logger.error({ err }, 'Twilio request failed');
      throw new AppError({
        status: 503,
        code: 'otp/provider-unavailable',
        message: 'Verification codes cannot be sent right now. Please try again shortly.',
      });
    }

    if (!res.ok) {
      logger.error({ status: res.status }, 'Twilio rejected OTP send');
      throw new AppError({
        status: res.status === 400 ? 422 : 503,
        code: res.status === 400 ? 'auth/invalid-phone' : 'otp/provider-unavailable',
        message:
          res.status === 400
            ? 'That number cannot receive verification codes.'
            : 'Verification codes cannot be sent right now. Please try again shortly.',
      });
    }
    const json = (await res.json().catch(() => ({}))) as { sid?: string; status?: string };
    const status = (json.status ?? '').toLowerCase();
    if (status === 'failed' || status === 'undelivered' || status === 'canceled' || status === 'cancelled') {
      logger.error({ status: res.status, providerStatus: status }, 'Twilio reported the OTP was not accepted');
      throw new AppError({
        status: 503,
        code: 'otp/provider-unavailable',
        message: 'Verification codes cannot be sent right now. Please try again shortly.',
      });
    }
    return { providerMessageId: json.sid, delivered: status === 'delivered' || status === 'read' };
  }
}

/**
 * SpearUC-style HTTP SMS gateway. The vendor URL already carries its credentials,
 * so this provider never logs the URL, the query string, or the message body.
 * A send counts as accepted only when the gateway returns HTTP 2xx and a body
 * that explicitly says the message was sent. That acceptance is not handset delivery.
 */
/** Gateway HTTP success is acceptance, not handset delivery. */
export function smsGatewayAccepted(httpOk: boolean, body: string): boolean {
  if (!httpOk) return false;
  const text = body.trim();
  if (!text) return false;
  try {
    const json = JSON.parse(text) as { status?: unknown };
    const status = String(json.status ?? '').toLowerCase();
    if (status === 'error' || status === 'failed' || status === 'fail') return false;
    if (status === 'success' || status === 'sent' || status === 'ok' || status === 'queued' || status === 'accepted') {
      return true;
    }
  } catch {
    /* The gateway sometimes answers with plain text. */
  }
  if (/fail|invalid|error|denied|reject/i.test(text)) return false;
  if (/sent|success|ok|accept|queued/i.test(text)) return true;
  return /^\d{1,20}$/.test(text);
}

export class SpearucOtpProvider implements OtpProvider {
  readonly name = 'spearuc';

  constructor(
    private readonly vendorUrl: string | undefined,
    private readonly messageTemplate: string | undefined = undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(request: OtpSendRequest): Promise<OtpSendResult> {
    if (!this.vendorUrl) {
      throw new AppError({
        status: 503,
        code: 'otp/provider-unavailable',
        message: 'Verification codes cannot be sent right now. Please try again shortly.',
      });
    }
    if (request.channel !== 'sms') {
      throw new AppError({
        status: 422,
        code: 'otp/channel-unsupported',
        message: 'This number can only receive SMS verification codes right now.',
      });
    }
    const url = new URL(this.vendorUrl);
    url.searchParams.set('mobile', request.to.replace(/^\+/, ''));
    const template = this.messageTemplate?.trim();
    const message = template?.includes('{otp}')
      ? template.replaceAll('{otp}', request.code)
      : `Your Mineral Bridge code is ${request.code}. It expires in ${Math.ceil(request.ttlSeconds / 60)} min. Never share it.`;
    url.searchParams.set('message', message);
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), { method: 'GET', signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.name : 'error' }, 'SMS gateway request failed');
      throw new AppError({
        status: 503,
        code: 'otp/provider-unavailable',
        message: 'Verification codes cannot be sent right now. Please try again shortly.',
      });
    }
    const text = await res.text().catch(() => '');
    const accepted = smsGatewayAccepted(res.ok, text);
    if (!accepted) {
      logger.error({ status: res.status }, 'SMS gateway rejected OTP send');
      throw new AppError({
        status: 503,
        code: 'otp/provider-unavailable',
        message: 'Verification codes cannot be sent right now. Please try again shortly.',
      });
    }
    return { providerMessageId: `spearuc_${Date.now()}`, delivered: false };
  }
}

/** `OTP_PROVIDER=africastalking` is accepted by env validation but not implemented yet. */
export class UnavailableOtpProvider implements OtpProvider {
  constructor(readonly name: string) {}
  async send(): Promise<OtpSendResult> {
    throw new AppError({
      status: 503,
      code: 'otp/provider-unavailable',
      message: 'Verification codes cannot be sent right now. Please try again shortly.',
    });
  }
}

export function createOtpProvider(): OtpProvider {
  const env = loadEnv();
  switch (env.OTP_PROVIDER) {
    case 'fake':
      if (env.NODE_ENV === 'production') {
        throw new Error('OTP_PROVIDER=fake is not allowed when NODE_ENV=production');
      }
      return new FakeOtpProvider();
    case 'twilio':
      return new TwilioOtpProvider({
        accountSid: env.TWILIO_ACCOUNT_SID,
        authToken: env.TWILIO_AUTH_TOKEN,
        fromNumber: env.TWILIO_FROM_NUMBER || env.TWILIO_SMS_FROM,
        whatsappFrom: env.TWILIO_WHATSAPP_FROM,
      });
    case 'spearuc':
      return new SpearucOtpProvider(env.SMS_VENDOR_URL, env.OTP_SMS_MESSAGE);
    default:
      return new UnavailableOtpProvider(env.OTP_PROVIDER);
  }
}

let current: OtpProvider | null = null;

export function getOtpProvider(): OtpProvider {
  if (!current) current = createOtpProvider();
  return current;
}

/** Test seam. */
export function setOtpProvider(provider: OtpProvider | null): void {
  current = provider;
}
