import { createHash } from 'node:crypto';
import path from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { forbidden, notFound, unprocessable } from '../../common/errors/app-error.js';
import { createSignedUrl } from '../../common/storage/signed-url.js';
import { opaqueId } from '../../common/utils/ids.js';
import { FileModel } from '../../models/file.model.js';
import type { IFileObject } from '../../models/file.model.js';
import { absoluteStoragePath, writeStoredFile } from '../storage/storage.service.js';

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'video/mp4']);
const PURPOSES = [
  'sell-photo',
  'document',
  'avatar',
  'listing-photo',
  'asm-document',
  'lc-document',
  'support-attachment',
  'general',
  // Doc 07 FILE-01 wire purposes (stored as-is for v2 ownership checks).
  'kyc',
  'sell_photo',
  'sell_document',
  'payment_proof',
  'refund_evidence',
  'delivery_photo',
  'support_attachment',
] as const;
export type UploadPurpose = (typeof PURPOSES)[number];
export const UPLOAD_PURPOSES = PURPOSES;

/** Accept doc 07 snake_case purposes and legacy hyphenated ones. */
export function normalizeUploadPurpose(raw: string): UploadPurpose | null {
  if ((PURPOSES as readonly string[]).includes(raw)) return raw as UploadPurpose;
  const aliases: Record<string, UploadPurpose> = {
    'sell-photo': 'sell_photo',
    'support-attachment': 'support_attachment',
  };
  const mapped = aliases[raw];
  return mapped ?? null;
}

const safeName = (n: string) => n.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-120) || 'file';

export const uploadsService = {
  /** Registers a pending file and returns where to PUT the bytes. */
  async createTarget(userId: string, input: { purpose: UploadPurpose; filename: string; contentType: string; bytes: number; refType?: string; refId?: string }) {
    if (!ALLOWED.has(input.contentType)) throw unprocessable('Unsupported file type', { contentType: 'Unsupported' }, 'upload/unsupported-type');
    if (input.bytes > MAX_UPLOAD_BYTES) throw unprocessable('File is too large', { bytes: `Max ${MAX_UPLOAD_BYTES} bytes` }, 'upload/too-large');
    const id = opaqueId('fil');
    const file = await FileModel.create({
      _id: id,
      ownerId: userId,
      purpose: input.purpose,
      filename: safeName(input.filename),
      contentType: input.contentType,
      bytes: 0,
      storageKey: `cust/${userId}/${id}/${safeName(input.filename)}`,
      refType: input.refType,
      refId: input.refId,
    });
    const url = createSignedUrl('file', id, 900).url.replace('/files/signed/file/', '/files/upload/');
    return { file: file.toObject() as IFileObject, upload: { method: 'PUT' as const, url, headers: { 'Content-Type': input.contentType }, maxBytes: MAX_UPLOAD_BYTES } };
  },

  async receive(fileId: string, data: Buffer, contentType: string | undefined): Promise<IFileObject> {
    const f = await FileModel.findById(fileId).lean<IFileObject>();
    if (!f) throw notFound('upload/not-found', 'Upload not found');
    if (f.bytes > 0) throw forbidden('upload/already-received', 'This upload has already been completed');
    if (data.length === 0 || data.length > MAX_UPLOAD_BYTES) throw unprocessable('Invalid file size', { bytes: 'Out of range' }, 'upload/too-large');
    if (contentType && contentType.split(';')[0] !== f.contentType) throw unprocessable('Content-Type does not match the declared type', { contentType: 'Mismatch' });
    await writeStoredFile(f.storageKey, data);
    const checksum = createHash('sha256').update(data).digest('hex');
    await FileModel.updateOne({ _id: fileId }, { $set: { bytes: data.length, checksum } });
    return { ...f, bytes: data.length, checksum };
  },

  async owned(userId: string, fileId: string): Promise<IFileObject> {
    const f = await FileModel.findOne({ _id: fileId, ownerId: userId, bytes: { $gt: 0 } }).lean<IFileObject>();
    if (!f) throw unprocessable('File not found or not uploaded', { fileId: 'Unknown file' }, 'upload/file-not-found');
    return f;
  },

  async ownedMany(userId: string, ids: string[]): Promise<IFileObject[]> {
    const uniq = [...new Set(ids)];
    const rows = await FileModel.find({ _id: { $in: uniq }, ownerId: userId, bytes: { $gt: 0 } }).lean<IFileObject[]>();
    if (rows.length !== uniq.length) throw unprocessable('One or more files were not found', { fileIds: 'Unknown file' }, 'upload/file-not-found');
    return rows;
  },

  async openForDownload(id: string) {
    const f = await FileModel.findById(id).lean<IFileObject>();
    if (!f || f.bytes === 0) throw notFound('file/not-found', 'File not found');
    const full = absoluteStoragePath(f.storageKey);
    if (!existsSync(full)) throw notFound('file/not-found', 'File not found');
    return { file: f, stream: createReadStream(full), name: path.basename(f.storageKey) };
  },

  signed: (fileId: string, ttlSeconds?: number) => createSignedUrl('file', fileId, ttlSeconds),
};
