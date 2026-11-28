import { existsSync } from 'node:fs';
import type { ReadStream } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { FileModel } from '../../../models/file.model.js';
import { KycDocumentModel } from '../../kyc/kyc.model.js';
import { absoluteStoragePath, openStoredFile } from '../../storage/storage.service.js';

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

export function storageKeyReady(storageKey: string | undefined | null): boolean {
  if (!storageKey) return false;
  try {
    return existsSync(absoluteStoragePath(storageKey));
  } catch {
    return false;
  }
}

function kycCaptureKey(userId: string, fileId: string, mimeType?: string): string | null {
  const hinted = mimeType ? EXT_BY_MIME[mimeType.split(';')[0]!.trim().toLowerCase()] : '';
  const exts = hinted ? [hinted] : ['jpg', 'jpeg', 'png', 'webp', 'pdf'];
  for (const ext of exts) {
    const key = path.posix.join('kyc', userId, `${fileId}.${ext}`);
    if (storageKeyReady(key)) return key;
  }
  return null;
}

export interface AdminFileView {
  fileId: string;
  filename: string;
  contentType: string;
  bytes: number;
  ready: boolean;
  kyc: boolean;
  url: string;
}

export async function describeAdminFiles(fileIds: string[]): Promise<Map<string, AdminFileView>> {
  const ids = [...new Set(fileIds.filter(Boolean))];
  const out = new Map<string, AdminFileView>();
  if (!ids.length) return out;
  const [stored, kycDocs] = await Promise.all([
    FileModel.find({ _id: { $in: ids } }).lean(),
    KycDocumentModel.find({ fileId: { $in: ids }, discardedAt: null }).select('fileId userId mimeType originalName').lean(),
  ]);
  const fileById = new Map(stored.map((file) => [file._id, file]));
  const kycById = new Map(kycDocs.map((doc) => [doc.fileId, doc]));
  for (const fileId of ids) {
    const file = fileById.get(fileId);
    const kyc = kycById.get(fileId);
    const kycFile = Boolean(kyc) || file?.purpose === 'kyc' || file?.refType === 'kyc' || file?.storageKey?.startsWith('kyc/');
    let ready = Boolean(file && file.bytes > 0 && !file.deletedAt && storageKeyReady(file.storageKey));
    if (!ready && kyc?.userId) {
      ready = Boolean(kycCaptureKey(String(kyc.userId), fileId, kyc.mimeType || file?.contentType));
    }
    const contentType = file?.contentType || kyc?.mimeType || 'application/octet-stream';
    out.set(fileId, {
      fileId,
      filename: file?.filename || kyc?.originalName || fileId,
      contentType,
      bytes: file?.bytes || 0,
      ready,
      kyc: Boolean(kycFile),
      url: ready ? `/v2/admin/files/${encodeURIComponent(fileId)}/content` : '',
    });
  }
  return out;
}

export async function openAdminFile(fileId: string): Promise<{
  contentType: string;
  filename: string;
  bytes: number;
  kyc: boolean;
  stream: ReadStream;
} | null> {
  const file = await FileModel.findById(fileId).lean();
  const kyc = await KycDocumentModel.findOne({ fileId, discardedAt: null }).select('userId mimeType originalName').lean();
  const kycFile = Boolean(kyc) || file?.purpose === 'kyc' || file?.refType === 'kyc' || Boolean(file?.storageKey?.startsWith('kyc/'));
  if (file && file.bytes > 0 && !file.deletedAt && storageKeyReady(file.storageKey)) {
    return {
      contentType: file.contentType || 'application/octet-stream',
      filename: file.filename || fileId,
      bytes: file.bytes,
      kyc: kycFile,
      stream: createReadStream(absoluteStoragePath(file.storageKey)),
    };
  }
  if (kyc?.userId) {
    const key = kycCaptureKey(String(kyc.userId), fileId, kyc.mimeType || file?.contentType);
    if (key) {
      const stream = openStoredFile(key);
      return {
        contentType: kyc.mimeType || file?.contentType || 'application/octet-stream',
        filename: kyc.originalName || file?.filename || path.posix.basename(key),
        bytes: file?.bytes || 0,
        kyc: true,
        stream,
      };
    }
  }
  return null;
}
