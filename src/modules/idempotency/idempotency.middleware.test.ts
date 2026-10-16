import { describe, expect, it } from 'vitest';
import {
  buildIdempotencyScope,
  canonicalise,
  decideExisting,
  fingerprintRequest,
  idempotencyCodes,
  IDEMPOTENCY_KEY_PATTERN,
} from './idempotency.middleware.js';

const NOW = new Date('2026-10-16T10:00:00Z');
const stored = (over: Record<string, unknown> = {}) =>
  ({
    fingerprint: 'fp',
    state: 'completed',
    status: 201,
    contentType: 'application/json',
    body: '{"id":"o1"}',
    lockedUntil: new Date(NOW.getTime() + 60_000),
    ...over,
  }) as Parameters<typeof decideExisting>[0];

describe('fingerprintRequest', () => {
  it('is stable across key order', () => {
    const a = fingerprintRequest({ method: 'POST', path: '/v1/orders', body: { a: 1, b: { c: 2, d: 3 } } });
    const b = fingerprintRequest({ method: 'post', path: '/v1/orders', body: { b: { d: 3, c: 2 }, a: 1 } });
    expect(a).toBe(b);
  });
  it('differs when the body, method or path differs', () => {
    const base = fingerprintRequest({ method: 'POST', path: '/v1/orders', body: { qty: 1 } });
    expect(fingerprintRequest({ method: 'POST', path: '/v1/orders', body: { qty: 2 } })).not.toBe(base);
    expect(fingerprintRequest({ method: 'PUT', path: '/v1/orders', body: { qty: 1 } })).not.toBe(base);
    expect(fingerprintRequest({ method: 'POST', path: '/v1/other', body: { qty: 1 } })).not.toBe(base);
  });
  it('treats undefined and null bodies alike and keeps array order significant', () => {
    expect(fingerprintRequest({ method: 'POST', path: '/x', body: undefined })).toBe(
      fingerprintRequest({ method: 'POST', path: '/x', body: null }),
    );
    expect(canonicalise([2, 1])).toEqual([2, 1]);
  });
});

describe('scope and key format', () => {
  it('scopes by actor, method and path', () => {
    expect(buildIdempotencyScope('u:1', 'post', '/v1/orders')).toBe('u:1|POST|/v1/orders');
  });
  it('accepts uuids and rejects junk', () => {
    expect(IDEMPOTENCY_KEY_PATTERN.test('b1f1c0de-1234-4abc-8def-0123456789ab')).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test('short')).toBe(false);
    expect(IDEMPOTENCY_KEY_PATTERN.test('has space in it!')).toBe(false);
  });
});

describe('decideExisting', () => {
  it('replays a completed request with the same fingerprint', () => {
    expect(decideExisting(stored(), 'fp', NOW)).toEqual({
      kind: 'replay',
      status: 201,
      contentType: 'application/json',
      body: '{"id":"o1"}',
    });
  });
  it('flags key reuse with a different request, even while in progress', () => {
    expect(decideExisting(stored(), 'other', NOW)).toEqual({ kind: 'key-reused' });
    expect(decideExisting(stored({ state: 'in_progress' }), 'other', NOW)).toEqual({ kind: 'key-reused' });
  });
  it('reports in-progress while the owner holds the lock', () => {
    expect(decideExisting(stored({ state: 'in_progress' }), 'fp', NOW)).toEqual({ kind: 'in-progress' });
  });
  it('lets a retry take over a crashed owner after the lock expires', () => {
    expect(decideExisting(stored({ state: 'in_progress', lockedUntil: new Date(NOW.getTime() - 1) }), 'fp', NOW)).toEqual({
      kind: 'takeover',
    });
  });
});

describe('idempotencyCodes', () => {
  it('uses idempotency/* for customers and conflict/* for admin', () => {
    expect(idempotencyCodes('mobile').reused).toBe('idempotency/key-reused');
    expect(idempotencyCodes('web').inProgress).toBe('idempotency/in-progress');
    expect(idempotencyCodes('admin').reused).toBe('conflict/duplicate');
    expect(idempotencyCodes('admin').inProgress).toBe('conflict/in-progress');
  });
});
