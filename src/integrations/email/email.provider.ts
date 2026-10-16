import { AppError } from '../../common/errors/app-error.js';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

/** Collects messages in memory. Tests read `outbox`; nothing is ever sent. */
export class FakeEmailProvider implements EmailProvider {
  readonly name = 'fake';
  readonly outbox: Array<EmailMessage & { sentAt: Date }> = [];

  async send(message: EmailMessage): Promise<void> {
    this.outbox.push({ ...message, sentAt: new Date() });
    if (loadEnv().NODE_ENV === 'development') {
      logger.info({ to: message.to, subject: message.subject }, '[fake-email] message captured');
    }
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
      message: 'Email cannot be sent right now. Please try again shortly.',
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

  async send(message: EmailMessage): Promise<void> {
    const transport = await this.getTransport();
    try {
      await transport.sendMail({
        from: this.config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    } catch (err) {
      logger.error({ err }, 'SMTP send failed');
      throw this.unavailable('send failed');
    }
  }
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
  if (env.NODE_ENV === 'production') {
    throw new Error('EMAIL_PROVIDER=fake is not allowed when NODE_ENV=production');
  }
  return new FakeEmailProvider();
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
