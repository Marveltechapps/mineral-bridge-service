import { AppError } from '../../common/errors/app-error.js';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/** Shown when the gateway refuses the destination (sender, template, or number rules). */
export const SMS_NUMBER_REJECTED_MESSAGE =
  "We couldn't send an SMS verification code to this number. Please check the number or verify using email.";

/** Shown when a provider is down or rejects the send for any other operational reason. */
export const VERIFICATION_SEND_FAILED_MESSAGE =
  "We couldn't send your verification code right now. Please try again or choose another verification method.";

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
      logger.info(
        { to: request.to, channel: request.channel },
        `[fake-otp] local development code ${request.code}`,
      );
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
        message: VERIFICATION_SEND_FAILED_MESSAGE,
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
        message: VERIFICATION_SEND_FAILED_MESSAGE,
      });
    }

    if (!res.ok) {
      logger.error({ status: res.status }, 'Twilio rejected OTP send');
      throw new AppError({
        status: res.status === 400 ? 422 : 503,
        code: res.status === 400 ? 'auth/invalid-phone' : 'otp/provider-unavailable',
        message:
          res.status === 400
            ? SMS_NUMBER_REJECTED_MESSAGE
            : VERIFICATION_SEND_FAILED_MESSAGE,
      });
    }
    const json = (await res.json().catch(() => ({}))) as { sid?: string; status?: string };
    const status = (json.status ?? '').toLowerCase();
    if (status === 'failed' || status === 'undelivered' || status === 'canceled' || status === 'cancelled') {
      logger.error({ status: res.status, providerStatus: status }, 'Twilio reported the OTP was not accepted');
      throw new AppError({
        status: 503,
        code: 'otp/provider-unavailable',
        message: VERIFICATION_SEND_FAILED_MESSAGE,
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
export function smsGatewayAccepted(httpOk: boolean, body: string, acceptCampaign = false): boolean {
  if (!httpOk) return false;
  const text = body.trim();
  if (!text) return false;
  if (acceptCampaign && /campaign successfully sent/i.test(text)) return true;
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
    private readonly acceptCampaign = false,
  ) {}

  private async submit(
    request: OtpSendRequest,
    mobile: string,
  ): Promise<{ httpOk: boolean; httpStatus: number; body: string }> {
    if (!this.vendorUrl) {
      throw new AppError({
        status: 503,
        code: 'otp/provider-unavailable',
        message: VERIFICATION_SEND_FAILED_MESSAGE,
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
    url.searchParams.set('mobile', mobile);
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
        message: VERIFICATION_SEND_FAILED_MESSAGE,
      });
    }
    const text = await res.text().catch(() => '');
    return { httpOk: res.ok, httpStatus: res.status, body: text };
  }

  async send(request: OtpSendRequest): Promise<OtpSendResult> {
    const digits = request.to.replace(/^\+/, '');
    const first = await this.submit(request, digits);
    const retryNational = !smsGatewayAccepted(first.httpOk, first.body, this.acceptCampaign) ? indianNational(digits) : null;
    const outcome =
      retryNational && gatewayStatusId(first.body) === 'error_1002' ? await this.submit(request, retryNational) : first;
    if (!smsGatewayAccepted(outcome.httpOk, outcome.body, this.acceptCampaign)) {
      const providerStatus = gatewayStatusId(outcome.body) || 'rejected';
      logger.error({ status: outcome.httpStatus, providerStatus }, 'SMS gateway rejected OTP send');
      const numberRejected = providerStatus === 'error_1002';
      throw new AppError({
        status: numberRejected ? 422 : 503,
        code: numberRejected ? 'auth/invalid-phone' : 'otp/provider-unavailable',
        message: numberRejected ? SMS_NUMBER_REJECTED_MESSAGE : VERIFICATION_SEND_FAILED_MESSAGE,
      });
    }
    return { providerMessageId: spearucMessageId(outcome.body), delivered: false };
  }
}

/** SpearUC drops numbers that are not a 10-digit Indian mobile and answers error_1002. */
function indianNational(digits: string): string | null {
  return /^91[6-9]\d{9}$/.test(digits) ? digits.slice(2) : null;
}

function gatewayStatusId(body: string): string {
  try {
    const json = JSON.parse(body) as { status_id?: unknown };
    return String(json.status_id ?? '').toLowerCase();
  } catch {
    return '';
  }
}

function spearucMessageId(body: string): string | undefined {
  const trimmed = body.trim();
  try {
    const json = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ['campaign_id', 'message_id', 'msg_id', 'id']) {
      const value = json[key];
      if (typeof value === 'string' || typeof value === 'number') return String(value);
    }
  } catch {
    /* Plain text or a bare id. */
  }
  return /^\d{1,20}$/.test(trimmed) ? trimmed : undefined;
}

/** `OTP_PROVIDER=africastalking` is accepted by env validation but not implemented yet. */
export class UnavailableOtpProvider implements OtpProvider {
  constructor(readonly name: string) {}
  async send(): Promise<OtpSendResult> {
    throw new AppError({
      status: 503,
      code: 'otp/provider-unavailable',
      message: VERIFICATION_SEND_FAILED_MESSAGE,
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
      return new SpearucOtpProvider(env.SMS_VENDOR_URL, env.OTP_SMS_MESSAGE, fetch, env.SMS_GATEWAY_ACCEPT_CAMPAIGN);
    default:
      return new UnavailableOtpProvider(env.OTP_PROVIDER);
  }
}

/** True when this process can attempt an SMS code. Fake is limited to non-production. */
export function isSmsDeliveryConfigured(env = loadEnv()): boolean {
  if (env.OTP_PROVIDER === 'twilio') {
    return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (env.TWILIO_FROM_NUMBER || env.TWILIO_SMS_FROM));
  }
  if (env.OTP_PROVIDER === 'spearuc') return Boolean(env.SMS_VENDOR_URL);
  if (env.OTP_PROVIDER === 'fake') return env.NODE_ENV !== 'production';
  return false;
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
