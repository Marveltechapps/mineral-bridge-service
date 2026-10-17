import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../common/errors/app-error.js';
import { FakeOtpProvider, SpearucOtpProvider, TwilioOtpProvider, createOtpProvider, smsGatewayAccepted } from './otp.provider.js';

const request = { to: '+2348024419087', code: '482910', channel: 'sms' as const, ttlSeconds: 60 };

describe('FakeOtpProvider', () => {
  it('remembers the last code per destination for tests', async () => {
    const p = new FakeOtpProvider();
    await p.send(request);
    await p.send({ ...request, code: '111222' });
    expect(p.lastCodeFor(request.to)).toBe('111222');
    expect(p.lastCodeFor('+2348000000000')).toBeUndefined();
    expect(p.sent).toHaveLength(2);
  });

  it('never returns the code from send()', async () => {
    const result = await new FakeOtpProvider().send(request);
    expect(JSON.stringify(result)).not.toContain(request.code);
  });

  it('clear() forgets everything', async () => {
    const p = new FakeOtpProvider();
    await p.send(request);
    p.clear();
    expect(p.lastCodeFor(request.to)).toBeUndefined();
    expect(p.sent).toHaveLength(0);
  });
});

describe('TwilioOtpProvider', () => {
  it('throws 503 otp/provider-unavailable when credentials are missing', async () => {
    const err = await new TwilioOtpProvider({}).send(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(503);
    expect((err as AppError).code).toBe('otp/provider-unavailable');
  });

  it('posts to the Messages API with basic auth when configured', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ sid: 'SM123' }), { status: 201 }));
    const p = new TwilioOtpProvider(
      { accountSid: 'AC1', authToken: 'tok', fromNumber: '+15550001111' },
      fetchImpl as unknown as typeof fetch,
    );
    const out = await p.send(request);
    expect(out.providerMessageId).toBe('SM123');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/Accounts/AC1/Messages.json');
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });

  it('treats a queued Twilio message as accepted but not delivered', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ sid: 'SM123', status: 'queued' }), { status: 201 }));
    const p = new TwilioOtpProvider(
      { accountSid: 'AC1', authToken: 'tok', fromNumber: '+15550001111' },
      fetchImpl as unknown as typeof fetch,
    );
    await expect(p.send(request)).resolves.toEqual({ providerMessageId: 'SM123', delivered: false });
  });

  it('does not accept a Twilio message the provider already marked failed', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ sid: 'SM9', status: 'failed' }), { status: 201 }));
    const p = new TwilioOtpProvider(
      { accountSid: 'AC1', authToken: 'tok', fromNumber: '+15550001111' },
      fetchImpl as unknown as typeof fetch,
    );
    await expect(p.send(request)).rejects.toMatchObject({ status: 503, code: 'otp/provider-unavailable' });
  });

  it('maps a provider 5xx to 503 without leaking details', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const p = new TwilioOtpProvider(
      { accountSid: 'AC1', authToken: 'tok', fromNumber: '+15550001111' },
      fetchImpl as unknown as typeof fetch,
    );
    await expect(p.send(request)).rejects.toMatchObject({ status: 503, code: 'otp/provider-unavailable' });
  });
});

describe('SpearucOtpProvider', () => {
  it('sends the approved template with the code substituted and does not treat acceptance as delivery', async () => {
    const fetchImpl = vi.fn(async () => new Response('Sent successfully', { status: 200 }));
    const provider = new SpearucOtpProvider(
      'http://sms.example.test/send?user=vendor&pass=secret',
      'Your code is {otp}. Do not share it.',
      fetchImpl as unknown as typeof fetch,
    );
    const result = await provider.send(request);
    expect(result.delivered).toBe(false);
    const called = (fetchImpl.mock.calls as unknown as [string][])[0]?.[0];
    expect(called).toBeTruthy();
    const url = new URL(called!);
    expect(url.searchParams.get('message')).toBe(`Your code is ${request.code}. Do not share it.`);
    expect(url.searchParams.get('message')).not.toContain('{otp}');
    expect(url.searchParams.get('mobile')).toBe('2348024419087');
  });

  it('rejects a gateway body that does not accept the message', async () => {
    const fetchImpl = vi.fn(async () => new Response('error: invalid sender', { status: 200 }));
    const provider = new SpearucOtpProvider('http://sms.example.test/send', undefined, fetchImpl as unknown as typeof fetch);
    await expect(provider.send(request)).rejects.toMatchObject({ code: 'otp/provider-unavailable' });
  });

  it('accepts a numeric gateway id without calling it delivered', () => {
    expect(smsGatewayAccepted(true, '884422')).toBe(true);
    expect(smsGatewayAccepted(true, '')).toBe(false);
    expect(smsGatewayAccepted(false, 'success')).toBe(false);
  });

  it('does not treat the gateway missing-number error as acceptance', () => {
    const body = '{"status":"error","Message":"Atleast one number is required to send message","status_id":"error_1002"}';
    expect(smsGatewayAccepted(true, body)).toBe(false);
    expect(smsGatewayAccepted(true, '{"status":"success","Message":"Message sent"}')).toBe(true);
  });
});

describe('createOtpProvider', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../../config/env.js');
  });

  it('refuses the fake provider in production', async () => {
    vi.resetModules();
    vi.doMock('../../config/env.js', () => ({
      loadEnv: () => ({ OTP_PROVIDER: 'fake', NODE_ENV: 'production', LOG_LEVEL: 'silent' }),
    }));
    const mod = await import('./otp.provider.js');
    expect(() => mod.createOtpProvider()).toThrow(/not allowed/);
  });

  it('builds the fake provider outside production', () => {
    expect(createOtpProvider().name).toBe('fake');
  });
});
