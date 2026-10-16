import mongoose, { Schema, type Model } from 'mongoose';

export type HttpIdempotencyState = 'in_progress' | 'completed';

export interface HttpIdempotencyShape {
  /** `${actor}|${METHOD}|${path}` — so one key can never collide across users or endpoints. */
  scope: string;
  key: string;
  /** sha256 of `{method, path, canonical body}`. */
  fingerprint: string;
  state: HttpIdempotencyState;
  /** Stored response (only meaningful when `completed`). */
  status?: number;
  contentType?: string;
  /** The exact serialised body; replays send these bytes back unchanged. */
  body?: string;
  /** A crashed owner stops blocking retries once this passes. */
  lockedUntil: Date;
  /** `createdAt + 24 h`; a TTL index removes the row. */
  expiresAt: Date;
  createdAt: Date;
}

const httpIdempotencySchema = new Schema<HttpIdempotencyShape>(
  {
    scope: { type: String, required: true },
    key: { type: String, required: true },
    fingerprint: { type: String, required: true },
    state: { type: String, enum: ['in_progress', 'completed'], default: 'in_progress', required: true },
    status: Number,
    contentType: String,
    body: String,
    lockedUntil: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

httpIdempotencySchema.index({ scope: 1, key: 1 }, { unique: true });
httpIdempotencySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Distinct model/collection name: other modules already own `IdempotencyRecord`.
export const HttpIdempotencyModel: Model<HttpIdempotencyShape> =
  (mongoose.models.HttpIdempotencyRecord as Model<HttpIdempotencyShape> | undefined) ??
  mongoose.model<HttpIdempotencyShape>('HttpIdempotencyRecord', httpIdempotencySchema, 'http_idempotency');
