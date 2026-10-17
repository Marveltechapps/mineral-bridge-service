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
  return failures;
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
  });
  if (failures.length) {
    throw new Error(`Refusing to start in production:\n${failures.map((f) => `- ${f}`).join('\n')}`);
  }
}
