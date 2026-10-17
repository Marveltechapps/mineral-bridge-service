import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeEmailProvider, ResendEmailProvider, SmtpEmailProvider } from './email.provider.js';

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
    });
  });

  it('resolves only after a 2xx response', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"id":"email_1"}', { status: 200 }));
    const provider = new ResendEmailProvider('test-key', 'Mineral Bridge <otp@example.com>', fetchImpl as unknown as typeof fetch);
    await provider.send({ to: 'a@x.com', subject: 'code', text: 'secret-code' });
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
