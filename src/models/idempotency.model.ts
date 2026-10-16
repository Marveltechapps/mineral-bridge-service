import { defineModel, pk } from './_shared.js';

export interface IIdempotencyRecord {
  _id: string;
  scope: string;
  key: string;
  bodyHash: string;
  state: 'in_progress' | 'done';
  status: number;
  result: unknown;
  expiresAt: Date;
  createdAt: Date;
}

export const IdempotencyModel = defineModel<IIdempotencyRecord>(
  'IdempotencyRecord',
  {
    _id: pk('idm'),
    scope: { type: String, required: true },
    key: { type: String, required: true },
    bodyHash: { type: String, required: true },
    state: { type: String, enum: ['in_progress', 'done'], default: 'in_progress' },
    status: { type: Number, default: 0 },
    result: { type: Object, default: null },
    expiresAt: { type: Date, required: true },
  },
  {
    indexes: [
      [{ scope: 1, key: 1 }, { unique: true }],
      [{ expiresAt: 1 }, { expireAfterSeconds: 0 }],
    ],
  },
);
