import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { AppError } from '../errors/app-error.js';

/** Weak ETag derived from the document identity + version. */
export function etagOf(...parts: Array<string | number | Date | undefined | null>): string {
  const raw = parts.map((p) => (p instanceof Date ? p.getTime() : String(p ?? ''))).join('|');
  return `W/"${createHash('sha1').update(raw).digest('hex').slice(0, 16)}"`;
}

/** ETag for a Mongo document using _id + __v + updatedAt. */
export function docEtag(doc: { _id?: unknown; __v?: number; updatedAt?: Date } | null | undefined): string {
  return etagOf(String(doc?._id), doc?.__v ?? 0, doc?.updatedAt);
}

export function setEtag(res: Response, etag: string): void {
  res.setHeader('ETag', etag);
}

const normalise = (s: string) => s.replace(/^W\//, '').replace(/"/g, '').trim();

/**
 * Edit-gated forms (#42, #57, #130, #132, #134): client must echo the ETag from the preceding GET.
 *   missing  → 428 conflict/if-match-required
 *   mismatch → 412 conflict/etag-mismatch
 */
export function assertIfMatch(req: Request, currentEtag: string): void {
  const header = req.header('if-match');
  if (!header) {
    throw new AppError({ status: 428, code: 'conflict/if-match-required', message: 'This change needs an If-Match header with the ETag from the last GET.' });
  }
  if (header.trim() === '*') return;
  const candidates = header.split(',').map(normalise);
  if (!candidates.includes(normalise(currentEtag))) {
    throw new AppError({
      status: 412,
      code: 'conflict/etag-mismatch',
      message: 'Someone else changed this — reload and try again.',
      current: currentEtag,
    });
  }
}
