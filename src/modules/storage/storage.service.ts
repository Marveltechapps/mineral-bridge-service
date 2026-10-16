import { createHmac } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError, notFound } from '../../common/errors/app-error.js';
import { safeEqual } from '../../common/utils/crypto.js';
import { loadEnv } from '../../config/env.js';

/** Contract §#17: short-lived (5 min) signed URL. */
export const SIGNED_URL_TTL_SECONDS = 300;

function sign(fileId: string, exp: number, disposition: string): string {
  const env = loadEnv();
  return createHmac('sha256', env.ADMIN_SESSION_SECRET).update(`${fileId}.${exp}.${disposition}`).digest('base64url');
}

export function signFileUrl(fileId: string, disposition: 'inline' | 'attachment' = 'inline') {
  const env = loadEnv();
  if (env.STORAGE_DRIVER !== 'local') {
    throw new AppError({
      status: 503,
      code: 'storage/s3-unavailable',
      message: 'S3 URL signing is not bundled in this build. Set STORAGE_DRIVER=local or add an S3 presigner.',
    });
  }
  const ttl = Math.min(env.STORAGE_SIGNED_URL_TTL_SECONDS, SIGNED_URL_TTL_SECONDS);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sig = sign(fileId, exp, disposition);
  const url = `${env.PUBLIC_API_BASE_URL}/storage/files/${encodeURIComponent(fileId)}?exp=${exp}&disp=${disposition}&sig=${sig}`;
  return { url, expiresAt: new Date(exp * 1000).toISOString() };
}

export function verifyFileSignature(fileId: string, exp: number, disposition: string, sig: string): boolean {
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  return safeEqual(sign(fileId, exp, disposition), sig);
}

export function absoluteStoragePath(storageKey: string): string {
  const root = path.resolve(loadEnv().STORAGE_LOCAL_ROOT);
  const full = path.resolve(root, storageKey);
  if (!full.startsWith(root + path.sep)) throw notFound('resource/not-found', 'File not found');
  return full;
}

export async function writeStoredFile(storageKey: string, data: Buffer | string): Promise<number> {
  const full = absoluteStoragePath(storageKey);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, data);
  return Buffer.byteLength(data);
}

export function openStoredFile(storageKey: string) {
  const full = absoluteStoragePath(storageKey);
  if (!existsSync(full)) throw notFound('resource/not-found', 'File not found');
  return createReadStream(full);
}
