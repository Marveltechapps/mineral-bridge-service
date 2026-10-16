import { defineModel, pk } from './_shared.js';

export interface IFileObject {
  _id: string;
  ownerId: string;
  purpose: string;
  filename: string;
  contentType: string;
  bytes: number;
  storageKey: string;
  checksum?: string;
  /** Private files are served only through short-lived signed URLs. */
  visibility: 'private' | 'public';
  refType?: string;
  refId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export const FileModel = defineModel<IFileObject>(
  'FileObject',
  {
    _id: pk('fil'),
    ownerId: { type: String, required: true, index: true },
    purpose: { type: String, required: true },
    filename: { type: String, required: true },
    contentType: { type: String, required: true },
    bytes: { type: Number, required: true },
    storageKey: { type: String, required: true },
    checksum: String,
    visibility: { type: String, enum: ['private', 'public'], default: 'private' },
    refType: String,
    refId: String,
  },
  { indexes: [[{ refType: 1, refId: 1 }]] },
);
