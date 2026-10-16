import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError, badRequest } from '../../common/errors/app-error.js';
import { fingerprintBody } from '../../common/utils/crypto.js';
import { HttpIdempotencyModel, type HttpIdempotencyShape } from './idempotency.model.js';

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a running request blocks duplicates before a crashed owner can be taken over. */
export const IDEMPOTENCY_LOCK_MS = 60_000;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_\-:.]{8,128}$/;

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit-tested without a database)
// ---------------------------------------------------------------------------------------------

/** Recursively sorts object keys so `{a,b}` and `{b,a}` fingerprint identically. */
export function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonicalise(v)]),
    );
  }
  return value;
}

export function fingerprintRequest(input: { method: string; path: string; body: unknown }): string {
  return fingerprintBody({
    method: input.method.toUpperCase(),
    path: input.path,
    body: canonicalise(input.body ?? null),
  });
}

export function buildIdempotencyScope(actorId: string, method: string, path: string): string {
  return `${actorId}|${method.toUpperCase()}|${path}`;
}

export type IdempotencyDecision =
  | { kind: 'replay'; status: number; contentType?: string; body?: string }
  | { kind: 'key-reused' }
  | { kind: 'in-progress' }
  | { kind: 'takeover' };

/** What to do when `(scope, key)` already exists. */
export function decideExisting(
  existing: Pick<HttpIdempotencyShape, 'fingerprint' | 'state' | 'status' | 'contentType' | 'body' | 'lockedUntil'>,
  fingerprint: string,
  now: Date,
): IdempotencyDecision {
  if (existing.fingerprint !== fingerprint) return { kind: 'key-reused' };
  if (existing.state === 'completed') {
    return { kind: 'replay', status: existing.status ?? 200, contentType: existing.contentType, body: existing.body };
  }
  return existing.lockedUntil.getTime() <= now.getTime() ? { kind: 'takeover' } : { kind: 'in-progress' };
}

/** Per-client vocabulary: admin uses the `conflict/*` codes from its contract. */
export function idempotencyCodes(client: string): {
  reused: string;
  inProgress: string;
  required: string;
  invalid: string;
} {
  return client === 'admin'
    ? {
        reused: 'conflict/duplicate',
        inProgress: 'conflict/in-progress',
        required: 'request/malformed',
        invalid: 'request/malformed',
      }
    : {
        reused: 'idempotency/key-reused',
        inProgress: 'idempotency/in-progress',
        required: 'idempotency/key-required',
        invalid: 'idempotency/key-invalid',
      };
}

function actorIdOf(req: Request): string {
  const a = req.actor;
  if (a?.kind === 'user') return `u:${a.userId}`;
  if (a?.kind === 'staff') return `s:${a.staffId}`;
  return `ip:${req.ip ?? 'unknown'}`;
}

// ---------------------------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------------------------

export interface IdempotencyOptions {
  /** `required` ⇒ `400` when the header is missing (money-moving calls). Default `optional`. */
  mode?: 'required' | 'optional';
}

/**
 * Mount AFTER auth and request validation, so only well-formed, authorised requests reserve a key.
 *
 *  - first request: reserves `(scope, key)`, runs the handler, stores status + body when `< 500`;
 *  - `>= 500`: reservation deleted so the client can retry with the same key;
 *  - same key + same request: original status/body replayed with `Idempotent-Replayed: true`;
 *  - same key + different request: `409` (`idempotency/key-reused`; admin `conflict/duplicate`);
 *  - same key while the first is running: `409` in-progress with `Retry-After`.
 */
export function idempotent(options: IdempotencyOptions = {}): RequestHandler {
  const mode = options.mode ?? 'optional';

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const codes = idempotencyCodes(req.apiClient);
      const key = req.header('idempotency-key')?.trim();
      if (!key) {
        if (mode === 'required') {
          throw badRequest(codes.required, 'Idempotency-Key header is required for this request', {
            'Idempotency-Key': 'Required',
          });
        }
        return next();
      }
      if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
        throw badRequest(codes.invalid, 'Idempotency-Key must be 8-128 URL-safe characters (a UUID is recommended)', {
          'Idempotency-Key': 'Invalid',
        });
      }
      req.idempotencyKey = key;

      const path = req.originalUrl.split('?')[0] ?? req.path;
      const scope = buildIdempotencyScope(actorIdOf(req), req.method, path);
      const fingerprint = fingerprintRequest({ method: req.method, path, body: req.body });
      const now = new Date();

      const owned = await reserve(scope, key, fingerprint, now);
      if (owned.kind !== 'owner') {
        if (owned.kind === 'replay') {
          res.setHeader('Idempotent-Replayed', 'true');
          res.status(owned.status);
          if (owned.contentType) res.type(owned.contentType);
          if (owned.body === undefined) res.end();
          else res.send(owned.body);
          return;
        }
        if (owned.kind === 'key-reused') {
          throw new AppError({
            status: 409,
            code: codes.reused,
            message: 'Idempotency-Key was already used with a different request.',
          });
        }
        res.setHeader('Retry-After', '1');
        throw new AppError({
          status: 409,
          code: codes.inProgress,
          message: 'A request with this Idempotency-Key is still being processed.',
        });
      }

      captureResponse(res, scope, key);
      next();
    } catch (err) {
      next(err);
    }
  };
}

type ReserveResult =
  | { kind: 'owner' }
  | { kind: 'replay'; status: number; contentType?: string; body?: string }
  | { kind: 'key-reused' }
  | { kind: 'in-progress' };

async function reserve(scope: string, key: string, fingerprint: string, now: Date): Promise<ReserveResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await HttpIdempotencyModel.create({
        scope,
        key,
        fingerprint,
        state: 'in_progress',
        lockedUntil: new Date(now.getTime() + IDEMPOTENCY_LOCK_MS),
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
      });
      return { kind: 'owner' };
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
    }

    const existing = await HttpIdempotencyModel.findOne({ scope, key }).lean<HttpIdempotencyShape>();
    if (!existing) continue; // released between our insert and read — try to claim again

    const decision = decideExisting(existing, fingerprint, now);
    if (decision.kind !== 'takeover') return decision;

    // The previous owner died mid-request. Exactly one retry wins the compare-and-set.
    const taken = await HttpIdempotencyModel.findOneAndUpdate(
      { scope, key, state: 'in_progress', lockedUntil: { $lte: now } },
      { $set: { lockedUntil: new Date(now.getTime() + IDEMPOTENCY_LOCK_MS) } },
    );
    if (taken) return { kind: 'owner' };
  }
  return { kind: 'in-progress' };
}

/**
 * `res.json` funnels into `res.send`, so wrapping `send` sees every body. The record is persisted
 * *before* the bytes leave, so an immediate retry always finds it.
 */
function captureResponse(res: Response, scope: string, key: string): void {
  const originalSend = res.send.bind(res);
  let settled = false;

  res.send = ((body?: unknown) => {
    if (settled) return originalSend(body as never);
    settled = true;

    const status = res.statusCode;
    const run = async (): Promise<void> => {
      try {
        if (status >= 500) {
          await HttpIdempotencyModel.deleteOne({ scope, key, state: 'in_progress' });
        } else {
          const serialised =
            body === undefined || body === null
              ? undefined
              : typeof body === 'string'
                ? body
                : Buffer.isBuffer(body)
                  ? body.toString('utf8')
                  : JSON.stringify(body);
          await HttpIdempotencyModel.updateOne(
            { scope, key },
            {
              $set: {
                state: 'completed',
                status,
                contentType: (res.getHeader('content-type') as string | undefined) ?? undefined,
                body: serialised,
              },
            },
          );
        }
      } catch {
        // Storing the replay is best effort; the lock expires on its own and the request still succeeds.
      }
    };
    void run().then(() => originalSend(body as never));
    return res;
  }) as typeof res.send;

  // A response with no body (`res.status(204).end()`) never calls `send`.
  const originalEnd = res.end.bind(res);
  res.end = ((...args: unknown[]) => {
    if (!settled) {
      settled = true;
      const status = res.statusCode;
      const done =
        status >= 500
          ? HttpIdempotencyModel.deleteOne({ scope, key, state: 'in_progress' })
          : HttpIdempotencyModel.updateOne({ scope, key }, { $set: { state: 'completed', status } });
      void Promise.resolve(done)
        .catch(() => undefined)
        .then(() => (originalEnd as (...a: unknown[]) => Response)(...args));
      return res;
    }
    return (originalEnd as (...a: unknown[]) => Response)(...args);
  }) as typeof res.end;
}
