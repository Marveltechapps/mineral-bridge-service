import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeEmailProvider, SmtpEmailProvider } from './email.provider.js';

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
