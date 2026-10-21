import { noPermissions } from '../staff/default-roles.js';
import { PERMISSION_MODULES, type AccessLevel, type PermissionModule, type Permissions } from '../staff/staff.types.js';

/** Development codes are 6 digits so they are not the web customer's 4-digit code. */
export const DEV_LOGIN_CODE_LENGTH = 6;
const MIN_PASSWORD_LENGTH = 8;
const MIN_TTL_SECONDS = 30;
const MAX_TTL_SECONDS = 300;

/**
 * Well-known codes are refused so a shared OTP cannot be configured.
 * This list is a denylist, not a code the server will accept.
 */
const WEAK_CODES = new Set([
  '123456',
  '654321',
  '000000',
  '111111',
  '222222',
  '333333',
  '444444',
  '555555',
  '666666',
  '777777',
  '888888',
  '999999',
  '121212',
  '123123',
  '112233',
]);

export interface DevLoginSecret {
  email: string;
  password: string;
  /** Absent when each challenge should generate its own code. */
  otp?: string;
}

export interface DevLoginConfig {
  nodeEnv: string;
  enabled: boolean;
  ttlSeconds: number;
  maxCredentialAttempts: number;
  maxOtpAttempts: number;
  app: DevLoginSecret | null;
  admin: (DevLoginSecret & { permissions: Permissions }) | null;
  /** Reason codes only. Never a password, OTP, or token. */
  misconfigured: string | null;
}

export interface DevLoginEnvInput {
  NODE_ENV: string;
  DEV_LOGIN_ENABLED: boolean;
  DEV_LOGIN_EMAIL?: string;
  DEV_LOGIN_PASSWORD?: string;
  DEV_LOGIN_OTP?: string;
  DEV_ADMIN_LOGIN_EMAIL?: string;
  DEV_ADMIN_LOGIN_PASSWORD?: string;
  DEV_ADMIN_LOGIN_OTP?: string;
  DEV_ADMIN_PERMISSIONS?: string;
  DEV_LOGIN_OTP_TTL_SECONDS: number;
  DEV_LOGIN_MAX_CREDENTIAL_ATTEMPTS: number;
  OTP_MAX_ATTEMPTS: number;
}

export function isAcceptableDevOtp(code: string): boolean {
  if (!/^\d{6}$/.test(code) || WEAK_CODES.has(code)) return false;
  const digits = [...code].map((char) => Number(char));
  if (digits.every((digit) => digit === digits[0])) return false;
  const ascending = digits.every((digit, index) => index === 0 || digit === (digits[index - 1]! + 1) % 10);
  const descending = digits.every((digit, index) => index === 0 || digit === (digits[index - 1]! + 9) % 10);
  return !ascending && !descending;
}

export function parseDevAdminPermissions(raw: string | undefined): Permissions | null {
  const text = raw?.trim() ?? '';
  if (!text) return null;
  const permissions = noPermissions();
  for (const part of text.split(',')) {
    const [moduleName, levelName] = part.split(':').map((piece) => piece.trim());
    if (!moduleName || !levelName) return null;
    if (!(PERMISSION_MODULES as readonly string[]).includes(moduleName)) return null;
    if (levelName !== 'none' && levelName !== 'view' && levelName !== 'edit') return null;
    permissions[moduleName as PermissionModule] = levelName as AccessLevel;
  }
  if (Object.values(permissions).every((level) => level === 'none')) return null;
  return permissions;
}

function readAudience(
  emailRaw: string | undefined,
  passwordRaw: string | undefined,
  otpRaw: string | undefined,
  problems: string[],
  label: string,
): DevLoginSecret | null {
  const email = emailRaw?.trim().toLowerCase() ?? '';
  const password = passwordRaw ?? '';
  const otp = otpRaw?.trim() ?? '';
  if (!email.includes('@') || email.length > 254 || password.length < MIN_PASSWORD_LENGTH) {
    problems.push(`${label}-credentials-incomplete`);
    return null;
  }
  if (otp && !isAcceptableDevOtp(otp)) {
    problems.push(`${label}-otp-rejected`);
    return null;
  }
  return { email, password, ...(otp ? { otp } : {}) };
}

export function readDevLoginConfig(env: DevLoginEnvInput): DevLoginConfig {
  const problems: string[] = [];
  const ttlSeconds = env.DEV_LOGIN_OTP_TTL_SECONDS;
  if (ttlSeconds < MIN_TTL_SECONDS || ttlSeconds > MAX_TTL_SECONDS) problems.push('otp-ttl-out-of-range');
  const maxCredentialAttempts = env.DEV_LOGIN_MAX_CREDENTIAL_ATTEMPTS;
  if (maxCredentialAttempts < 1 || maxCredentialAttempts > 20) problems.push('credential-attempt-limit');

  const appRequested = [env.DEV_LOGIN_EMAIL, env.DEV_LOGIN_PASSWORD, env.DEV_LOGIN_OTP].some((value) => Boolean(value?.trim()));
  const adminRequested = [
    env.DEV_ADMIN_LOGIN_EMAIL,
    env.DEV_ADMIN_LOGIN_PASSWORD,
    env.DEV_ADMIN_LOGIN_OTP,
    env.DEV_ADMIN_PERMISSIONS,
  ].some((value) => Boolean(value?.trim()));
  let app = appRequested
    ? readAudience(env.DEV_LOGIN_EMAIL, env.DEV_LOGIN_PASSWORD, env.DEV_LOGIN_OTP, problems, 'app')
    : null;
  let adminSecret = adminRequested
    ? readAudience(env.DEV_ADMIN_LOGIN_EMAIL, env.DEV_ADMIN_LOGIN_PASSWORD, env.DEV_ADMIN_LOGIN_OTP, problems, 'admin')
    : null;
  const permissions = parseDevAdminPermissions(env.DEV_ADMIN_PERMISSIONS);
  let admin: DevLoginConfig['admin'] = null;
  if (adminSecret && !permissions) {
    problems.push('admin-permissions-missing');
    adminSecret = null;
  } else if (adminSecret && permissions) {
    admin = { ...adminSecret, permissions };
  }
  if (app && admin && app.email === admin.email) {
    problems.push('admin-email-matches-app');
    app = null;
    admin = null;
  }
  const enabled = env.DEV_LOGIN_ENABLED === true;
  if (enabled && !app && !admin && problems.length === 0) problems.push('no-audience-configured');
  return {
    nodeEnv: env.NODE_ENV,
    enabled,
    ttlSeconds,
    maxCredentialAttempts,
    maxOtpAttempts: env.OTP_MAX_ATTEMPTS,
    app: enabled ? app : null,
    admin: enabled ? admin : null,
    misconfigured: enabled && problems.length > 0 ? problems.join(',') : null,
  };
}

/** The only switch that turns an audience on. Production cannot satisfy it. */
export function isAudienceEnabled(config: DevLoginConfig, audience: 'app' | 'admin'): boolean {
  if (config.nodeEnv !== 'development' || config.enabled !== true) return false;
  if (config.misconfigured?.includes('otp-ttl-out-of-range')) return false;
  if (config.misconfigured?.includes('credential-attempt-limit')) return false;
  return audience === 'app' ? config.app !== null : config.admin !== null;
}
