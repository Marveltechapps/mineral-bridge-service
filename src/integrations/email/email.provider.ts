import { AppError } from '../../common/errors/app-error.js';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailSendResult {
  providerMessageId?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

/** Collects messages in memory. Tests read `outbox`; nothing is ever sent. */
export class FakeEmailProvider implements EmailProvider {
  readonly name = 'fake';
  readonly outbox: Array<EmailMessage & { sentAt: Date }> = [];

  async send(message: EmailMessage): Promise<EmailSendResult> {
    this.outbox.push({ ...message, sentAt: new Date() });
    if (loadEnv().NODE_ENV === 'development') {
      const code = message.text.match(/\b(\d{4,8})\b/)?.[1];
      logger.info(
        { to: message.to, subject: message.subject },
        `[fake-email] local development code ${code ?? 'unavailable'}`,
      );
    }
    return {};
  }

  lastTo(address: string): (EmailMessage & { sentAt: Date }) | undefined {
    for (let i = this.outbox.length - 1; i >= 0; i -= 1) {
      if (this.outbox[i]!.to === address) return this.outbox[i];
    }
    return undefined;
  }

  clear(): void {
    this.outbox.length = 0;
  }
}

export interface SmtpConfig {
  host?: string;
  port?: number;
  user?: string;
  pass?: string;
  from: string;
}

/**
 * SMTP stub. `nodemailer` is intentionally not a hard dependency yet: it is loaded
 * dynamically, and the provider throws `503 email/provider-unavailable` when either the
 * SMTP settings or the module are missing.
 */
export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp';
  private transport: { sendMail(msg: Record<string, unknown>): Promise<unknown> } | null = null;

  constructor(private readonly config: SmtpConfig) {}

  private unavailable(reason: string): AppError {
    logger.error({ reason }, 'SMTP email provider unavailable');
    return new AppError({
      status: 503,
      code: 'email/provider-unavailable',
      message: "We couldn't send your verification code right now. Please try again or choose another verification method.",
    });
  }

  private async getTransport() {
    if (this.transport) return this.transport;
    const { host, port, user, pass } = this.config;
    if (!host || !port) throw this.unavailable('SMTP_HOST / SMTP_PORT not configured');
    const moduleName = 'nodemailer';
    let nodemailer: {
      createTransport(opts: Record<string, unknown>): {
        sendMail(msg: Record<string, unknown>): Promise<unknown>;
      };
    };
    try {
      const mod = (await import(moduleName)) as { default?: unknown } & Record<string, unknown>;
      nodemailer = (mod.default ?? mod) as typeof nodemailer;
    } catch {
      throw this.unavailable('nodemailer is not installed');
    }
    this.transport = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: user && pass ? { user, pass } : undefined,
    });
    return this.transport;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const transport = await this.getTransport();
    try {
      const info = (await transport.sendMail({
        from: this.config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      })) as { messageId?: string };
      return { providerMessageId: info.messageId };
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.name : 'error' }, 'SMTP send failed');
      throw this.unavailable('send failed');
    }
  }
}

export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';

  constructor(
    private readonly apiKey: string | undefined,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (!this.apiKey) {
      logger.error('Resend API key is not configured');
      throw new AppError({
        status: 503,
        code: 'email/provider-unavailable',
        message: "We couldn't send your verification code right now. Please try again or choose another verification method.",
      });
    }
    let res: Response;
    try {
      res = await this.fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.name : 'error' }, 'Resend request failed');
      throw new AppError({
        status: 503,
        code: 'email/provider-unavailable',
        message: "We couldn't send your verification code right now. Please try again or choose another verification method.",
      });
    }
    const body = await res.text().catch(() => '');
    if (!res.ok) throw resendRejection(res.status, body);
    let providerMessageId: string | undefined;
    try {
      const json = JSON.parse(body) as { id?: unknown };
      if (typeof json.id === 'string') providerMessageId = json.id;
    } catch {
      /* A 2xx body without an id still means Resend accepted the request. */
    }
    logger.info({ providerMessageId, delivered: false }, 'Resend accepted the email request');
    return { providerMessageId };
  }
}

function resendRejection(status: number, body: string): AppError {
  let name = '';
  let detail = '';
  try {
    const json = JSON.parse(body) as { name?: unknown; message?: unknown };
    name = String(json.name ?? '');
    detail = String(json.message ?? '');
  } catch {
    detail = '';
  }
  const invalidKey = status === 401 || /api key/i.test(detail);
  const unverifiedDomain = /domain/i.test(detail) && /verif/i.test(detail);
  logger.error(
    { status, providerError: name || 'rejected', invalidKey, unverifiedDomain },
    'Resend rejected the message',
  );
  return new AppError({
    status: 503,
    code: 'email/provider-unavailable',
    message: "We couldn't send your verification code right now. Please try again or choose another verification method.",
  });
}

export function createEmailProvider(): EmailProvider {
  const env = loadEnv();
  if (env.EMAIL_PROVIDER === 'smtp') {
    return new SmtpEmailProvider({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      from: env.EMAIL_FROM,
    });
  }
  if (env.EMAIL_PROVIDER === 'resend') {
    return new ResendEmailProvider(env.RESEND_API_KEY, env.RESEND_FROM || env.EMAIL_FROM);
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('EMAIL_PROVIDER=fake is not allowed when NODE_ENV=production');
  }
  return new FakeEmailProvider();
}

/** True when this process can attempt an email code. Fake is limited to non-production. */
export function isEmailDeliveryConfigured(env = loadEnv()): boolean {
  if (env.EMAIL_PROVIDER === 'resend') return Boolean(env.RESEND_API_KEY);
  if (env.EMAIL_PROVIDER === 'smtp') return Boolean(env.SMTP_HOST && env.SMTP_PORT);
  if (env.EMAIL_PROVIDER === 'fake') return env.NODE_ENV !== 'production';
  return false;
}

let current: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (!current) current = createEmailProvider();
  return current;
}

/** Test seam. */
export function setEmailProvider(provider: EmailProvider | null): void {
  current = provider;
}
