import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError, badRequest, conflict } from '../errors/app-error.js';
import { fingerprintBody } from '../utils/crypto.js';
import { IdempotencyRecord } from '../../models/platform.models.js';

const TTL_MS = 24 * 3_600_000;

/**
 * Idempotency-Key for state-changing POSTs.
 *  - replay within 24 h with the same body → original status + body (header Idempotent-Replay: true)
 *  - same key, different body → 409 conflict/duplicate
 *  - concurrent duplicate while the first is running → 409 conflict/in-progress
 *  - failed (>=400) responses are not stored, so the client can fix the request and retry with the same key
 * mode 'required' is used on the money-moving calls #32, #52, #72, #106.
 */
export function idempotency(mode: 'optional' | 'required'): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = req.header('idempotency-key')?.trim();
      if (!key) {
        if (mode === 'required') {
          throw badRequest('request/malformed', 'Idempotency-Key header is required for this operation', {
            'Idempotency-Key': 'Required',
          });
        }
        return next();
      }
      if (key.length > 128) throw badRequest('request/malformed', 'Idempotency-Key is too long (max 128 characters)');

      req.idempotencyKey = key;
      const actorId = req.actor?.kind === 'staff' ? req.actor.staffId : req.ip ?? 'anon';
      const path = req.originalUrl.split('?')[0];
      const scope = `${actorId}|${req.method}|${path}|${key}`;
      const bodyHash = fingerprintBody(req.body);

      try {
        await IdempotencyRecord.create({ scope, bodyHash, state: 'in_progress', expiresAt: new Date(Date.now() + TTL_MS) });
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err;
        const existing = await IdempotencyRecord.findOne({ scope }).lean();
        if (!existing) throw conflict('conflict/in-progress', 'A request with this Idempotency-Key is in progress');
        if (existing.bodyHash !== bodyHash) {
          throw conflict('conflict/duplicate', 'Idempotency-Key was already used with a different request body');
        }
        if (existing.state !== 'completed') {
          throw new AppError({ status: 409, code: 'conflict/in-progress', message: 'A request with this Idempotency-Key is still in progress' });
        }
        res.setHeader('Idempotent-Replay', 'true');
        res.status(existing.status ?? 200);
        if (existing.body === undefined || existing.body === null) {
          res.end();
        } else {
          res.json(existing.body);
        }
        return;
      }

      let settled = false;
      const persist = (status: number, body: unknown) => {
        settled = true;
        return status < 400
          ? IdempotencyRecord.updateOne({ scope }, { $set: { state: 'completed', status, body: body ?? null } })
          : IdempotencyRecord.deleteOne({ scope });
      };
      const originalJson = res.json.bind(res);
      // Persist BEFORE the client sees the response so an immediate replay always finds it.
      res.json = ((body: unknown) => {
        const status = res.statusCode;
        void persist(status, body)
          .catch(() => undefined)
          .then(() => originalJson(body));
        return res;
      }) as typeof res.json;

      res.on('finish', () => {
        if (!settled) void persist(res.statusCode, null).catch(() => undefined);
      });
      res.on('close', () => {
        if (!res.writableFinished) void IdempotencyRecord.deleteOne({ scope, state: 'in_progress' }).catch(() => undefined);
      });
      next();
    } catch (err) {
      next(err);
    }
  };
}
