import { conflict } from '../errors/app-error.js';
import { fingerprintBody } from '../utils/crypto.js';
import { addMs, DAY_MS, now } from '../utils/clock.js';
import { IdempotencyModel } from '../../models/idempotency.model.js';
import type { IIdempotencyRecord } from '../../models/idempotency.model.js';

export type IdempotentOutcome<T> = { result: T; status: number; replayed: boolean };

const POLL_INTERVAL_MS = 40;
const MAX_WAIT_MS = 10_000;

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Exactly-once execution for money/bid/order creates (24 h window).
 *
 * - First call claims `(scope, key)` with a unique index, runs `fn`, stores the response.
 * - Replays with the same body return the stored response (`replayed: true`).
 * - Same key, different body -> `409 idempotency/key-reused`.
 * - A concurrent duplicate waits for the in-flight call to finish, then replays.
 * - If `fn` throws the claim is released so the client may retry with the same key.
 *
 * `result` must be JSON/BSON-serialisable (primitives, Dates, plain objects).
 */
export async function runIdempotent<T>(opts: {
  scope: string;
  key: string;
  body: unknown;
  successStatus?: number;
  fn: () => Promise<T>;
  ttlMs?: number;
}): Promise<IdempotentOutcome<T>> {
  const bodyHash = fingerprintBody(opts.body);
  const deadline = Date.now() + MAX_WAIT_MS;

  for (;;) {
    let claimed: IIdempotencyRecord | null = null;
    try {
      const doc = await IdempotencyModel.create({
        scope: opts.scope,
        key: opts.key,
        bodyHash,
        state: 'in_progress',
        expiresAt: addMs(now(), opts.ttlMs ?? DAY_MS),
      });
      claimed = doc.toObject() as IIdempotencyRecord;
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }

    if (claimed) {
      try {
        const result = await opts.fn();
        const status = opts.successStatus ?? 200;
        await IdempotencyModel.updateOne({ _id: claimed._id }, { $set: { state: 'done', status, result } });
        return { result, status, replayed: false };
      } catch (err) {
        await IdempotencyModel.deleteOne({ _id: claimed._id, state: 'in_progress' });
        throw err;
      }
    }

    const existing = await IdempotencyModel.findOne({ scope: opts.scope, key: opts.key }).lean();
    if (!existing) continue; // claim was released between our insert and read; retry
    if (existing.bodyHash !== bodyHash) {
      throw conflict('idempotency/key-reused', 'Idempotency-Key was already used with a different request body');
    }
    if (existing.state === 'done') {
      return { result: existing.result as T, status: existing.status, replayed: true };
    }
    if (Date.now() > deadline) {
      throw conflict('idempotency/in-progress', 'A request with this Idempotency-Key is still being processed');
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

export function idempotencyScope(userId: string, operation: string, extra?: string): string {
  return extra ? `${userId}:${operation}:${extra}` : `${userId}:${operation}`;
}
