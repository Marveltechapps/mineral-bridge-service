import { createHmac } from 'node:crypto';
import { AppError, unauthorized } from '../../common/errors/app-error.js';
import { generateOpaqueToken, safeEqual } from '../../common/utils/crypto.js';
import { loadEnv } from '../../config/env.js';

/**
 * Staff SSO (admin #2/#3). Only the redirect leg is implemented: the IdP's token exchange needs a
 * concrete provider (Entra ID / Google Workspace), which is registered with `setSsoProvider`.
 *
 * Configuration (all required to enable SSO; otherwise every SSO call is `503 auth/sso-not-configured`):
 *   ADMIN_SSO_AUTHORIZE_URL   e.g. https://login.microsoftonline.com/<tenant>/oauth2/v2.0/authorize
 *   ADMIN_SSO_CLIENT_ID
 *   ADMIN_SSO_REDIRECT_URI    the console route that posts `code` + `state` to #3
 */
export interface SsoConfig {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  scope: string;
}

export interface SsoIdentity {
  email: string;
  subject: string;
}

export interface SsoIdentityProvider {
  exchangeCode(input: { code: string; redirectUri: string }): Promise<SsoIdentity>;
}

export function getSsoConfig(): SsoConfig | null {
  const authorizeUrl = process.env.ADMIN_SSO_AUTHORIZE_URL;
  const clientId = process.env.ADMIN_SSO_CLIENT_ID;
  const redirectUri = process.env.ADMIN_SSO_REDIRECT_URI;
  if (!authorizeUrl || !clientId || !redirectUri) return null;
  return { authorizeUrl, clientId, redirectUri, scope: process.env.ADMIN_SSO_SCOPE ?? 'openid email profile' };
}

export function ssoNotConfigured(): AppError {
  return new AppError({
    status: 503,
    code: 'auth/sso-not-configured',
    message:
      'Single sign-on is not configured for this environment. Sign in with your email and password instead.',
  });
}

let provider: SsoIdentityProvider | null = null;

export function setSsoProvider(next: SsoIdentityProvider | null): void {
  provider = next;
}

export function getSsoProvider(): SsoIdentityProvider | null {
  return provider;
}

// ---- signed `state` (CSRF + carries the hint email and return path across the IdP round trip) ----

interface SsoState {
  email: string;
  returnTo: string;
  nonce: string;
  exp: number;
}

const STATE_TTL_SECONDS = 600;

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`sso:${payload}`).digest('base64url');
}

export function signSsoState(
  input: { email: string; returnTo: string },
  now = new Date(),
  secret = loadEnv().ADMIN_SESSION_SECRET,
): string {
  const state: SsoState = {
    email: input.email,
    returnTo: input.returnTo,
    nonce: generateOpaqueToken(12),
    exp: Math.floor(now.getTime() / 1000) + STATE_TTL_SECONDS,
  };
  const payload = Buffer.from(JSON.stringify(state)).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySsoState(
  token: string,
  now = new Date(),
  secret = loadEnv().ADMIN_SESSION_SECRET,
): SsoState {
  const invalid = () => unauthorized('auth/invalid-credentials', 'The single sign-on request is no longer valid. Try again.');
  const [payload, sig] = token.split('.');
  if (!payload || !sig || !safeEqual(sig, sign(payload, secret))) throw invalid();
  let state: SsoState;
  try {
    state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SsoState;
  } catch {
    throw invalid();
  }
  if (typeof state.exp !== 'number' || state.exp * 1000 < now.getTime()) throw invalid();
  return state;
}

export function buildSsoRedirectUrl(config: SsoConfig, input: { email: string; returnTo: string }): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('login_hint', input.email);
  url.searchParams.set('state', signSsoState(input));
  return url.toString();
}

/** Only same-origin absolute paths — never `//evil.com` or a full URL (open-redirect guard). */
export function sanitizeReturnTo(value: string | undefined | null, fallback = '/overview'): string {
  if (!value) return fallback;
  return /^\/(?!\/)[A-Za-z0-9\-._~/?=&%#]*$/.test(value) ? value : fallback;
}
