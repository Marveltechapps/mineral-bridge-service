import { Router, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import type { ZodTypeAny } from 'zod';
import { requireStaffPermission } from '../../auth/auth.middleware.js';
import { adminSession, csrfProtect } from './staff-context.js';
import { idempotency } from '../../../common/middleware/idempotency.js';
import { validate } from '../../../common/middleware/validate.js';
import { loadEnv } from '../../../config/env.js';
import type { PermissionModule } from '../../../models/shared.js';
import { wrap, type AsyncHandler } from './http.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type RouteAuth = 'public' | 'challenge' | 'reset-token' | 'session' | 'locked-session';
export type Perm =
  | 'public'
  | 'challenge'
  | 'reset-token'
  | 'auth' // any signed-in staff member
  | 'locked-ok' // signed-in even while the console is locked (#10, #11, #12)
  | 'file-owner' // permission follows the owning record (#17)
  | readonly [PermissionModule, 'view' | 'edit'];

export type AdminRouteDef = {
  /** Endpoint number from API-ENDPOINTS.md (1..139). */
  n: number;
  method: HttpMethod;
  /** Express path relative to /admin/v1, e.g. /orders/:orderId */
  path: string;
  auth: RouteAuth;
  permission?: { module: PermissionModule; level: 'view' | 'edit' };
  idempotency: 'off' | 'optional' | 'required';
  middleware: RequestHandler[];
  handler: RequestHandler;
  sse?: boolean;
};

export type RouteOptions = {
  /** Override default idempotency (POST → optional, others → off). */
  idem?: 'off' | 'optional' | 'required';
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
  sse?: boolean;
  /** For handlers that stream and must not be wrapped by `wrap`. */
  raw?: boolean;
};

/**
 *   route(23, 'GET /orders', ['orders','view'], handler)
 * One line per endpoint keeps the registry auditable against endpoint-inventory.json.
 */
export function route(n: number, spec: string, perm: Perm, handler: AsyncHandler, opts: RouteOptions = {}): AdminRouteDef {
  const [method, path] = spec.split(' ') as [HttpMethod, string];
  let auth: RouteAuth;
  let permission: AdminRouteDef['permission'];
  if (perm === 'public' || perm === 'challenge' || perm === 'reset-token') auth = perm;
  else if (perm === 'locked-ok') auth = 'locked-session';
  else {
    auth = 'session';
    if (Array.isArray(perm)) permission = { module: perm[0], level: perm[1] };
  }
  const middleware: RequestHandler[] = [];
  if (opts.params || opts.query || opts.body) middleware.push(validate({ params: opts.params, query: opts.query, body: opts.body }));
  return {
    n,
    method,
    path,
    auth,
    permission,
    idempotency: opts.idem ?? (method === 'POST' && auth === 'session' ? 'optional' : 'off'),
    middleware,
    handler: wrap(handler),
    sse: opts.sse,
  };
}

/** Literal path segments must be registered before `:param` siblings (/orders/intake vs /orders/:orderId). */
function specificity(path: string): number[] {
  return path.split('/').filter(Boolean).map((seg) => (seg.startsWith(':') ? 1 : 0));
}

export function sortBySpecificity(defs: AdminRouteDef[]): AdminRouteDef[] {
  return [...defs].sort((a, b) => {
    const sa = specificity(a.path);
    const sb = specificity(b.path);
    if (sa.length !== sb.length) return sa.length - sb.length;
    for (let i = 0; i < sa.length; i++) {
      if (sa[i] !== sb[i]) return sa[i]! - sb[i]!;
    }
    return a.n - b.n;
  });
}

function authLimiter(): RequestHandler {
  const env = loadEnv();
  return rateLimit({
    windowMs: 60_000,
    limit: env.AUTH_RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => env.NODE_ENV === 'test',
    keyGenerator: (req) => `${req.ip}|${String((req.body as { email?: string } | undefined)?.email ?? '').toLowerCase()}`,
    validate: false,
    handler: (_req, res) => {
      res.setHeader('Retry-After', '60');
      res.status(429).json({ code: 'rate-limited', message: 'Too many attempts. Try again in a minute.' });
    },
  });
}

export function buildAdminRouter(defs: AdminRouteDef[]): Router {
  const router = Router();
  const limiter = authLimiter();
  for (const def of sortBySpecificity(defs)) {
    const stack: RequestHandler[] = [];
    if (def.auth === 'public' || def.auth === 'challenge' || def.auth === 'reset-token') {
      stack.push(limiter);
    } else {
      stack.push(adminSession({ allowLocked: def.auth === 'locked-session' }), csrfProtect);
      if (def.permission) stack.push(requireStaffPermission(def.permission.module, def.permission.level));
    }
    stack.push(...def.middleware);
    if (def.idempotency !== 'off' && def.auth !== 'public') stack.push(idempotency(def.idempotency));
    stack.push(def.handler);
    router[def.method.toLowerCase() as 'get'](def.path, ...stack);
  }
  return router;
}

/** `/orders/:orderId` → `/orders/{orderId}` (inventory notation). */
export const toInventoryPath = (path: string): string => path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
