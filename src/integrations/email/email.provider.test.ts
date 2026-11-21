import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeEmailProvider, ResendEmailProvider, SmtpEmailProvider, smtpFromAddress } from './email.provider.js';

describe('FakeEmailProvider', () => {
  it('captures messages in the outbox', async () => {
    const p = new FakeEmailProvider();
    await p.send({ to: 'a@x.com', subject: 'Hi', text: 'one' });
    await p.send({ to: 'a@x.com', subject: 'Hi again', text: 'two' });
    expect(p.outbox).toHaveLength(2);
    expect(p.lastTo('a@x.com')?.text).toBe('two');
    expect(p.lastTo('b@x.com')).toBeUndefined();
    p.clear();
    expect(p.outbox).toHaveLength(0);
  });
});

describe('smtpFromAddress', () => {
  it('uses the authenticated Gmail mailbox when the configured From address is different', () => {
    expect(
      smtpFromAddress({
        host: 'smtp.gmail.com',
        user: 'desk@gmail.com',
        from: 'support@mineralbridge.com',
      }),
    ).toBe('Mineral Bridge <desk@gmail.com>');
  });

  it('keeps a matching From address', () => {
    expect(
      smtpFromAddress({
        host: 'smtp.gmail.com',
        user: 'desk@gmail.com',
        from: 'Mineral Bridge <desk@gmail.com>',
      }),
    ).toBe('Mineral Bridge <desk@gmail.com>');
  });
});

describe('SmtpEmailProvider', () => {
  it('throws 503 email/provider-unavailable without host/port', async () => {
    const p = new SmtpEmailProvider({ from: 'no-reply@mineralbridge.test' });
    await expect(p.send({ to: 'a@x.com', subject: 's', text: 't' })).rejects.toMatchObject({
      status: 503,
      code: 'email/provider-unavailable',
    });
  });
});

describe('ResendEmailProvider', () => {
  it('does not report success unless Resend accepts the message', async () => {
    const fetchImpl = vi.fn(async () => new Response('no', { status: 401 }));
    const provider = new ResendEmailProvider('test-key', 'Mineral Bridge <otp@example.com>', fetchImpl as unknown as typeof fetch);
    await expect(provider.send({ to: 'a@x.com', subject: 'code', text: 'secret-code' })).rejects.toMatchObject({
      code: 'email/provider-unavailable',
      message: "We couldn't send your verification code right now. Please try again or choose another verification method.",
    });
  });

  it('names an unverified sending domain', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"name":"validation_error","message":"The domain is not verified."}', { status: 403 }),
    );
    const provider = new ResendEmailProvider('test-key', 'Mineral Bridge <otp@example.com>', fetchImpl as unknown as typeof fetch);
    await expect(provider.send({ to: 'a@x.com', subject: 'code', text: 'secret-code' })).rejects.toMatchObject({
      message: "We couldn't send your verification code right now. Please try again or choose another verification method.",
    });
  });

  it('resolves only after a 2xx response and keeps the provider id', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"id":"email_1"}', { status: 200 }));
    const provider = new ResendEmailProvider('test-key', 'Mineral Bridge <otp@example.com>', fetchImpl as unknown as typeof fetch);
    await expect(provider.send({ to: 'a@x.com', subject: 'code', text: 'secret-code' })).resolves.toEqual({
      providerMessageId: 'email_1',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe('createEmailProvider', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../../config/env.js');
  });

  it('refuses the fake provider in production', async () => {
    vi.resetModules();
    vi.doMock('../../config/env.js', () => ({
      loadEnv: () => ({ EMAIL_PROVIDER: 'fake', NODE_ENV: 'production', LOG_LEVEL: 'silent' }),
    }));
    const mod = await import('./email.provider.js');
    expect(() => mod.createEmailProvider()).toThrow(/not allowed/);
  });
});
