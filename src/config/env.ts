import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),

  MONGODB_URI: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  ADMIN_SESSION_SECRET: z.string().min(32),
  WS_TOKEN_SECRET: z.string().min(32),

  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  MOBILE_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(5_184_000),
  WEB_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
  ADMIN_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(1800),
  ADMIN_ABSOLUTE_TTL_SECONDS: z.coerce.number().int().positive().default(43_200),
  REFRESH_REUSE_GRACE_SECONDS: z.coerce.number().int().nonnegative().default(10),

  CORS_WEB_ORIGINS: z.string().default('http://localhost:5173'),
  CORS_ADMIN_ORIGINS: z.string().default('http://localhost:5174'),
  CORS_MOBILE_ORIGINS: z.string().default(''),

  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  WEB_REFRESH_COOKIE_NAME: z.string().default('mb_refresh'),
  ADMIN_SESSION_COOKIE_NAME: z.string().default('mb_admin_session'),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_ROOT: z.string().default('./uploads'),
  STORAGE_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),

  OTP_PROVIDER: z.enum(['fake', 'twilio', 'africastalking']).default('fake'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OTP_MAX_PER_PHONE_15MIN: z.coerce.number().int().positive().default(3),
  OTP_MAX_PER_IP_15MIN: z.coerce.number().int().positive().default(20),

  EMAIL_PROVIDER: z.enum(['fake', 'smtp']).default('fake'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().default('noreply@mineralbridge.com'),

  PAYMENT_PROVIDER: z.string().optional(),
  IDENTITY_PROVIDER: z.string().optional(),
  BLOCKCHAIN_PROVIDER: z.string().optional(),
  RATE_FEED_PROVIDER: z.string().optional(),
  ESIGN_PROVIDER: z.string().optional(),

  // Staff SSO (OIDC-style). Unset => /auth/sso/* return 503 auth/sso-unconfigured.
  SSO_AUTHORIZE_URL: z.string().optional(),
  SSO_TOKEN_URL: z.string().optional(),
  SSO_USERINFO_URL: z.string().optional(),
  SSO_CLIENT_ID: z.string().optional(),
  SSO_CLIENT_SECRET: z.string().optional(),
  SSO_REDIRECT_URI: z.string().optional(),
  STAFF_EMAIL_DOMAINS: z.string().default('mineralbridge.co.ke,mineralbridge.com'),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  PUBLIC_API_BASE_URL: z.string().url().default('http://localhost:4000'),
});

export type Env = z.infer<typeof envSchema> & {
  corsWebOrigins: string[];
  corsAdminOrigins: string[];
  corsMobileOrigins: string[];
};

function splitOrigins(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;

  const defaultsForTest: Record<string, string> = {};
  if (process.env.NODE_ENV === 'test') {
    defaultsForTest.MONGODB_URI =
      process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/mineralbridge_test';
    defaultsForTest.JWT_ACCESS_SECRET =
      process.env.JWT_ACCESS_SECRET ?? 'test-access-secret-min-32-characters!!';
    defaultsForTest.JWT_REFRESH_SECRET =
      process.env.JWT_REFRESH_SECRET ?? 'test-refresh-secret-min-32-characters!';
    defaultsForTest.ADMIN_SESSION_SECRET =
      process.env.ADMIN_SESSION_SECRET ?? 'test-admin-session-secret-min-32!!';
    defaultsForTest.WS_TOKEN_SECRET =
      process.env.WS_TOKEN_SECRET ?? 'test-ws-token-secret-min-32-chars!!!!';
  }

  const parsed = envSchema.safeParse({ ...defaultsForTest, ...process.env });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const data = parsed.data;
  cached = {
    ...data,
    COOKIE_SECURE: Boolean(data.COOKIE_SECURE),
    corsWebOrigins: splitOrigins(data.CORS_WEB_ORIGINS),
    corsAdminOrigins: splitOrigins(data.CORS_ADMIN_ORIGINS),
    corsMobileOrigins: splitOrigins(data.CORS_MOBILE_ORIGINS),
  };
  return cached;
}

export function resetEnvCache(): void {
  cached = null;
}
