import type { Env } from './env.js';

const WEAK_SECRET = /change-me|dev-|test-|min-32/i;

export interface ProductionGuardInput {
  nodeEnv: string;
  otpProvider: string;
  emailProvider: string;
  cookieSecure: boolean;
  secrets: Record<string, string | undefined>;
  otpTestOtp?: string;
  debugMode?: string;
  /** Customer web origins from CORS_WEB_ORIGINS. Required and https in production. */
  corsWebOrigins?: string[];
  /** Admin dashboard origins from CORS_ADMIN_ORIGINS. Required, https, and disjoint from the web list. */
  corsAdminOrigins?: string[];
  /** Legacy combined list. Must be unset in production so it cannot collapse the two lists. */
  allowedOrigins?: string;
}

/** Reasons production must not boot. Empty means the process may start. */
export function productionGuardFailures(input: ProductionGuardInput): string[] {
  if (input.nodeEnv !== 'production') return [];
  const failures: string[] = [];
  if (input.otpProvider === 'fake') {
    failures.push('OTP_PROVIDER=fake is not allowed in production');
  }
  if (input.emailProvider === 'fake') {
    failures.push('EMAIL_PROVIDER=fake is not allowed in production');
  }
  if (!input.cookieSecure) {
    failures.push('COOKIE_SECURE must be true in production');
  }
  for (const [name, value] of Object.entries(input.secrets)) {
    if (!value || value.length < 32 || WEAK_SECRET.test(value)) {
      failures.push(`${name} must be a unique secret of at least 32 characters`);
    }
  }
  if (input.otpTestOtp) {
    failures.push('OTP_TEST_OTP is a fixed-code bypass and must be unset in production');
  }
  if (input.debugMode === '1' || input.debugMode === 'true') {
    failures.push('DEBUG_MODE must be off in production');
  }
  const web = input.corsWebOrigins ?? [];
  const admin = input.corsAdminOrigins ?? [];
  if (web.length === 0) {
    failures.push('CORS_WEB_ORIGINS must list the customer web origins');
  }
  if (admin.length === 0) {
    failures.push('CORS_ADMIN_ORIGINS must list the admin dashboard origins');
  }
  const overlap = web.filter((origin) => admin.includes(origin));
  if (overlap.length > 0) {
    failures.push(
      `CORS_WEB_ORIGINS and CORS_ADMIN_ORIGINS must be disjoint (shared: ${overlap.join(', ')})`,
    );
  }
  if ((input.allowedOrigins ?? '').trim()) {
    failures.push(
      'ALLOWED_ORIGINS must be unset in production. Set CORS_WEB_ORIGINS and CORS_ADMIN_ORIGINS separately',
    );
  }
  for (const origin of [...web, ...admin]) {
    const problem = productionOriginProblem(origin);
    if (problem) failures.push(`CORS origin ${origin} ${problem}`);
  }
  return failures;
}

function productionOriginProblem(origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return 'is not a valid origin';
  }
  if (url.protocol !== 'https:') return 'must use https';
  if (url.username || url.password || url.search || url.hash) return 'must be an origin with no userinfo, query or hash';
  if (url.pathname !== '/' && url.pathname !== '') return 'must not include a path';
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host.endsWith('.local')) {
    return 'must not be a loopback host';
  }
  return null;
}

export function assertProductionConfig(env: Env): void {
  const failures = productionGuardFailures({
    nodeEnv: env.NODE_ENV,
    otpProvider: env.OTP_PROVIDER,
    emailProvider: env.EMAIL_PROVIDER,
    cookieSecure: env.COOKIE_SECURE,
    secrets: {
      JWT_ACCESS_SECRET: env.JWT_ACCESS_SECRET,
      JWT_REFRESH_SECRET: env.JWT_REFRESH_SECRET,
      ADMIN_SESSION_SECRET: env.ADMIN_SESSION_SECRET,
      WS_TOKEN_SECRET: env.WS_TOKEN_SECRET,
    },
    otpTestOtp: process.env.OTP_TEST_OTP,
    debugMode: process.env.DEBUG_MODE,
    corsWebOrigins: env.corsWebOrigins,
    corsAdminOrigins: env.corsAdminOrigins,
    allowedOrigins: process.env.ALLOWED_ORIGINS,
  });
  if (failures.length) {
    throw new Error(`Refusing to start in production:\n${failures.map((f) => `- ${f}`).join('\n')}`);
  }
}
