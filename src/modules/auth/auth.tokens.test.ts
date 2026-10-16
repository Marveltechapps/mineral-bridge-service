import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  signAccessToken,
  verifyAccessToken,
  type AccessTokenClaims,
} from './auth.tokens.js';

const claims: AccessTokenClaims = { sub: 'u1', sid: 'ses_abc', cli: 'mobile', roles: ['buyer'] };

describe('access tokens', () => {
  it('round-trips the claims', () => {
    const { token, expiresIn } = signAccessToken(claims);
    expect(expiresIn).toBeGreaterThan(0);
    expect(verifyAccessToken(token)).toEqual({ ok: true, claims });
  });

  it('reports expired tokens as expired', () => {
    const { token } = signAccessToken(claims, { ttlSeconds: -10 });
    expect(verifyAccessToken(token)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a tampered token', () => {
    const { token } = signAccessToken(claims);
    const [h, p, s] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(p!, 'base64url').toString()), cli: 'web' }),
    ).toString('base64url');
    expect(verifyAccessToken(`${h}.${forgedPayload}.${s}`)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a token signed with another secret', () => {
    const { token } = signAccessToken(claims, { secret: 'another-secret-another-secret-another!' });
    expect(verifyAccessToken(token)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects the wrong audience (an admin token is not a customer token)', () => {
    const secret = 'test-access-secret-min-32-characters!!';
    const token = jwt.sign({ sid: 's', cli: 'web', roles: [] }, secret, {
      subject: 'u1',
      issuer: ACCESS_TOKEN_ISSUER,
      audience: 'mineralbridge:admin',
      expiresIn: 60,
    });
    expect(ACCESS_TOKEN_AUDIENCE).toBe('mineralbridge:customer');
    expect(verifyAccessToken(token)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects alg=none', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ ...claims, iss: ACCESS_TOKEN_ISSUER, aud: ACCESS_TOKEN_AUDIENCE })).toString('base64url');
    expect(verifyAccessToken(`${header}.${payload}.`).ok).toBe(false);
  });

  it('rejects garbage', () => {
    expect(verifyAccessToken('not-a-jwt')).toEqual({ ok: false, reason: 'invalid' });
  });
});
