import { FileObject } from '../../../models/platform.models.js';
import { iso } from './http.js';

export type FileRef = { id: string; name: string; mimeType: string; sizeBytes: number; uploadedAt: string | null; uploadedBy?: string };

export async function loadFileRefs(ids: Array<string | null | undefined>): Promise<Map<string, FileRef>> {
  const list = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  const map = new Map<string, FileRef>();
  if (!list.length) return map;
  for (const f of await FileObject.find({ fileId: { $in: list } }).lean()) {
    map.set(f.fileId, { id: f.fileId, name: f.name, mimeType: f.mimeType, sizeBytes: f.sizeBytes, uploadedAt: iso(f.uploadedAt), ...(f.uploadedBy ? { uploadedBy: f.uploadedBy } : {}) });
  }
  return map;
}
