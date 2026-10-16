import type { CorsOptions } from 'cors';
import { loadEnv } from './env.js';

export function buildCorsOptions(): CorsOptions {
  const env = loadEnv();
  const allowed = new Set([
    ...env.corsWebOrigins,
    ...env.corsAdminOrigins,
    ...env.corsMobileOrigins,
  ]);

  return {
    origin(origin, callback) {
      // Non-browser clients (mobile native, curl, server-to-server) send no Origin
      if (!origin) {
        callback(null, true);
        return;
      }
      if (env.NODE_ENV !== 'production' && allowed.size === 0) {
        callback(null, true);
        return;
      }
      if (allowed.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`CORS origin denied: ${origin}`));
    },
    credentials: true,
    exposedHeaders: [
      'X-Request-Id',
      'X-CSRF-Token',
      'ETag',
      'Retry-After',
      'Location',
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
    ],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Accept',
      'Accept-Language',
      'Idempotency-Key',
      'X-Request-Id',
      'X-Client',
      'X-Platform',
      'X-Device-Id',
      'X-CSRF-Token',
      'X-Transaction-Pin',
      'X-Timezone',
      'If-Match',
      'Last-Event-ID',
    ],
  };
}
