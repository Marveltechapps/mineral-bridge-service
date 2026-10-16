import type { NextFunction, Request, Response } from 'express';
import { badRequest } from '../errors/app-error.js';

const KEY_RE = /^[A-Za-z0-9_\-:.]{8,128}$/;

/** Capture `Idempotency-Key` into `req.idempotencyKey`; `required` enforces presence (400). */
export function idempotencyKey(required = true) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const key = req.header('idempotency-key');
    if (!key) {
      if (required) {
        next(badRequest('idempotency/key-required', 'Idempotency-Key header is required for this request'));
        return;
      }
      next();
      return;
    }
    if (!KEY_RE.test(key)) {
      next(badRequest('idempotency/key-invalid', 'Idempotency-Key must be 8-128 URL-safe characters (UUID recommended)'));
      return;
    }
    req.idempotencyKey = key;
    next();
  };
}

export function requireKeyOrThrow(req: Request): string {
  if (!req.idempotencyKey) throw badRequest('idempotency/key-required', 'Idempotency-Key header is required');
  return req.idempotencyKey;
}
