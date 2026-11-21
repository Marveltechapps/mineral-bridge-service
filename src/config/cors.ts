import type { CorsOptions, CorsOptionsDelegate, CorsRequest } from 'cors';
import { loadEnv } from './env.js';

/** Staff-only API prefixes. Customer (web/mobile) browser origins get no CORS grant here. */
export function isAdminPath(path: string): boolean {
  return path.startsWith('/v2/admin') || path.startsWith('/admin/');
}

/**
 * Per-request CORS: admin routes accept only admin origins; customer routes accept web, admin and mobile origins.
 * Falls back to the combined list when no admin origins are configured, so a minimal dev setup keeps working.
 */
export function buildCorsDelegate(): CorsOptionsDelegate<CorsRequest> {
  const env = loadEnv();
  const base = buildCorsOptions();
  const adminOnly = buildCorsOptions(new Set(env.corsAdminOrigins));
  return (req, cb) => {
    const r = req as CorsRequest & { path?: string; url?: string };
    const path = r.path ?? (r.url ?? '').split('?')[0] ?? '';
    cb(null, isAdminPath(path) && env.corsAdminOrigins.length > 0 ? adminOnly : base);
  };
}

export function buildCorsOptions(only?: Set<string>): CorsOptions {
  const env = loadEnv();
  const allowed = only ?? new Set([
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
      'X-Requested-With',
      'X-Transaction-Pin',
      'X-Timezone',
      'If-Match',
      'Last-Event-ID',
    ],
  };
}
