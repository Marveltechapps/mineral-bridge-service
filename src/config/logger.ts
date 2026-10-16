import pino from 'pino';
import { loadEnv } from './env.js';

const SENSITIVE_KEYS = new Set([
  'password',
  'pin',
  'otp',
  'code',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'cookie',
  'csrfToken',
  'secret',
]);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) || SENSITIVE_KEYS.has(k) ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return value;
}

export function createLogger() {
  const env = loadEnv();
  return pino({
    level: env.LOG_LEVEL,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-csrf-token"]',
        'req.headers["x-transaction-pin"]',
        'body.password',
        'body.otp',
        'body.code',
        'body.refreshToken',
        'body.pin',
      ],
      censor: '[REDACTED]',
    },
    transport:
      env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
        : undefined,
  });
}

export const logger = createLogger();
export { redact };
