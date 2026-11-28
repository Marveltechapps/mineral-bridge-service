import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError, unprocessable } from '../../common/errors/app-error.js';
import { IdPrefixes, opaqueId } from '../../common/utils/ids.js';
import { loadEnv } from '../../config/env.js';
import type { KycDocKind } from './kyc.types.js';

export const KYC_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export type DetectedMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';

/** Trust the bytes, not the client-declared Content-Type. */
export function sniffMime(buffer: Buffer): DetectedMime | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** Mobile registry: `document/too-large` (>10 MB), `document/unsupported-type` (not PDF/JPG/PNG). */
export function validateKycUpload(kind: KycDocKind, buffer: Buffer): DetectedMime {
  if (buffer.length > KYC_MAX_UPLOAD_BYTES) {
    throw unprocessable('File is larger than 10 MB.', { file: 'Maximum size is 10 MB' }, 'document/too-large');
  }
  const mime = sniffMime(buffer);
  if (!mime || (kind === 'selfie' && mime === 'application/pdf')) {
    throw unprocessable(
      kind === 'selfie' ? 'A selfie must be a JPG or PNG image.' : 'Upload a PDF, JPG or PNG file.',
      { file: 'Unsupported file type' },
      'document/unsupported-type',
    );
  }
  return mime;
}

export interface StoredKycFile {
  fileId: string;
  sizeBytes: number;
  mimeType: DetectedMime;
}

export interface KycFileStore {
  save(input: { userId: string; buffer: Buffer; mimeType: DetectedMime }): Promise<StoredKycFile>;
}

const EXT: Record<DetectedMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/**
 * Local-disk store under `STORAGE_LOCAL_ROOT/kyc/<userId>/`. The file name is a server-generated id —
 * the client-supplied name is never used on disk (no traversal). The S3 driver belongs to the
 * files module; until it is wired, `STORAGE_DRIVER=s3` answers 503 rather than writing to local disk
 * on a host where that would be silently ephemeral.
 */
export class LocalKycFileStore implements KycFileStore {
  async save(input: { userId: string; buffer: Buffer; mimeType: DetectedMime }): Promise<StoredKycFile> {
    const env = loadEnv();
    if (env.STORAGE_DRIVER !== 'local') {
      throw new AppError({
        status: 503,
        code: 'server/unavailable',
        message: 'Document storage is not available right now.',
      });
    }
    const fileId = opaqueId(IdPrefixes.file);
    const dir = path.resolve(env.STORAGE_LOCAL_ROOT, 'kyc', input.userId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${fileId}.${EXT[input.mimeType]}`), input.buffer, { flag: 'wx' });
    return { fileId, sizeBytes: input.buffer.length, mimeType: input.mimeType };
  }
}

let store: KycFileStore = new LocalKycFileStore();

export function getKycFileStore(): KycFileStore {
  return store;
}

export function setKycFileStore(next: KycFileStore): void {
  store = next;
}

/**
 * Web captures reference a `fileId` from `POST /uploads`. Until the files module exists the
 * default accepts only well-formed ids. Plug in the real ownership check with `setKycFileResolver`.
 * (`addDocument` additionally refuses a fileId already attached to another user's KYC record.)
 */
export type KycFileResolver = (userId: string, fileId: string) => Promise<boolean>;

let resolver: KycFileResolver = async (_userId, fileId) => /^fil_[A-Za-z0-9]{8,32}$/.test(fileId);

export function getKycFileResolver(): KycFileResolver {
  return resolver;
}

export function setKycFileResolver(next: KycFileResolver): void {
  resolver = next;
}
