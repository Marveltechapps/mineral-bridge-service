import { describe, expect, it } from 'vitest';
import { buildSsoRedirectUrl, sanitizeReturnTo, signSsoState, verifySsoState } from './admin.sso.js';

const SECRET = 'sso-test-secret-sso-test-secret-123';

describe('sanitizeReturnTo', () => {
  it('accepts same-origin paths', () => {
    expect(sanitizeReturnTo('/orders?tab=open')).toBe('/orders?tab=open');
  });
  it('falls back for open-redirect attempts and empties', () => {
    expect(sanitizeReturnTo('//evil.com')).toBe('/overview');
    expect(sanitizeReturnTo('https://evil.com')).toBe('/overview');
    expect(sanitizeReturnTo('javascript:alert(1)')).toBe('/overview');
    expect(sanitizeReturnTo(undefined)).toBe('/overview');
    expect(sanitizeReturnTo('')).toBe('/overview');
  });
});

describe('SSO state', () => {
  it('round-trips', () => {
    const t = signSsoState({ email: 'a@mineralbridge.com', returnTo: '/vault' }, new Date(), SECRET);
    expect(verifySsoState(t, new Date(), SECRET)).toMatchObject({ email: 'a@mineralbridge.com', returnTo: '/vault' });
  });

  it('rejects a tampered state', () => {
    const t = signSsoState({ email: 'a@mineralbridge.com', returnTo: '/vault' }, new Date(), SECRET);
    const [p, s] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ email: 'ceo@mineralbridge.com', returnTo: '/', nonce: 'x', exp: 9e9 })).toString('base64url');
    expect(() => verifySsoState(`${forged}.${s}`, new Date(), SECRET)).toThrow();
    expect(() => verifySsoState(`${p}.bad`, new Date(), SECRET)).toThrow();
  });

  it('rejects an expired state', () => {
    const t = signSsoState({ email: 'a@mineralbridge.com', returnTo: '/' }, new Date(Date.now() - 3_600_000), SECRET);
    expect(() => verifySsoState(t, new Date(), SECRET)).toThrow();
  });
});

describe('buildSsoRedirectUrl', () => {
  it('builds an authorisation-code redirect with a signed state', () => {
    const url = new URL(
      buildSsoRedirectUrl(
        { authorizeUrl: 'https://idp.example/authorize', clientId: 'cid', redirectUri: 'https://admin.example/cb', scope: 'openid email' },
        { email: 'a@mineralbridge.com', returnTo: '/overview' },
      ),
    );
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('login_hint')).toBe('a@mineralbridge.com');
    expect(url.searchParams.get('state')).toContain('.');
  });
});
