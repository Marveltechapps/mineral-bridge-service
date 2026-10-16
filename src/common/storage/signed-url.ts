import { createHmac } from 'node:crypto';
import { loadEnv } from '../../config/env.js';
import { addMs, now } from '../utils/clock.js';
import { safeEqual } from '../utils/crypto.js';

export type SignedUrl = { url: string; expiresAt: Date; expiresIn: number };

function sign(payload: string): string {
  return createHmac('sha256', loadEnv().WS_TOKEN_SECRET).update(payload).digest('base64url');
}

/**
 * Short-lived signed URL for private objects. The default driver is "local": the URL points at the
 * API's own file route; with `STORAGE_DRIVER=s3` replace this with a presigned S3 GET.
 */
export function createSignedUrl(kind: 'file' | 'order-doc' | 'contract' | 'lc-doc', id: string, ttlSeconds?: number): SignedUrl {
  const env = loadEnv();
  const ttl = ttlSeconds ?? env.STORAGE_SIGNED_URL_TTL_SECONDS;
  const expiresAt = addMs(now(), ttl * 1000);
  const exp = Math.floor(expiresAt.getTime() / 1000);
  const sig = sign(`${kind}:${id}:${exp}`);
  const url = `${env.PUBLIC_API_BASE_URL}/v1/files/signed/${kind}/${encodeURIComponent(id)}?exp=${exp}&sig=${sig}`;
  return { url, expiresAt, expiresIn: ttl };
}

export function verifySignedUrl(kind: string, id: string, exp: number, sig: string): boolean {
  if (!Number.isFinite(exp) || exp * 1000 < now().getTime()) return false;
  return safeEqual(sign(`${kind}:${id}:${exp}`), sig);
}
