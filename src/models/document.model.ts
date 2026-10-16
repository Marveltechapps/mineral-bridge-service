import { defineModel, pk } from './_shared.js';

export type DocStatus = 'uploaded' | 'in_review' | 'verified' | 'rejected';

/** User compliance document. Mobile `/documents` and web `/account/documents` are the same collection. */
export interface IUserDocument {
  _id: string;
  ownerId: string;
  name: string;
  kind: string;
  fileId?: string;
  contentType?: string;
  bytes?: number;
  status: DocStatus;
  issuedAt?: Date;
  expiresAt?: Date;
  reviewerNotes?: string;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const UserDocumentModel = defineModel<IUserDocument>(
  'UserDocument',
  {
    _id: pk('doc'),
    ownerId: { type: String, required: true },
    name: { type: String, required: true },
    kind: { type: String, required: true },
    fileId: String,
    contentType: String,
    bytes: Number,
    status: { type: String, enum: ['uploaded', 'in_review', 'verified', 'rejected'], default: 'uploaded' },
    issuedAt: Date,
    expiresAt: Date,
    reviewerNotes: String,
    deletedAt: Date,
  },
  { indexes: [[{ ownerId: 1, createdAt: -1 }]] },
);
