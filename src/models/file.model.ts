import type { ActorRef } from './schema-primitives.js';
import { defineModel, pk } from './_shared.js';

export interface IFileObject {
  _id: string;
  ownerId: string;
  /** Structured owner used for permission routing (absorbs adm_files.owner). */
  owner?: { type: string; id: string };
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
  uploadedBy?: ActorRef;
  scan?: { status: 'pending' | 'clean' | 'infected'; at?: Date };
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const FileModel = defineModel<IFileObject>(
  'FileObject',
  {
    _id: pk('fil'),
    ownerId: { type: String, required: true, index: true },
    owner: { type: { type: String }, id: String },
    purpose: { type: String, required: true },
    filename: { type: String, required: true },
    contentType: { type: String, required: true },
    bytes: { type: Number, required: true },
    storageKey: { type: String, required: true },
    checksum: String,
    visibility: { type: String, enum: ['private', 'public'], default: 'private' },
    refType: String,
    refId: String,
    uploadedBy: { type: Object },
    scan: {
      status: { type: String, enum: ['pending', 'clean', 'infected'], default: 'pending' },
      at: Date,
    },
    deletedAt: Date,
  },
  { indexes: [[{ refType: 1, refId: 1 }], [{ 'owner.type': 1, 'owner.id': 1 }]] },
);
