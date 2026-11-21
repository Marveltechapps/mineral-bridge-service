import mongoose, { Schema, type Model } from 'mongoose';

export type OutboxStatus = 'pending' | 'processing' | 'delivered' | 'failed' | 'dead';

export interface OutboxEventShape {
  eventId: string;
  topic: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: Date;
  lastError?: string;
  deliveredAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const outboxSchema = new Schema<OutboxEventShape>(
  {
    eventId: { type: String, required: true, unique: true },
    topic: { type: String, required: true, index: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: ['pending', 'processing', 'delivered', 'failed', 'dead'],
      default: 'pending',
      index: true,
    },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: () => new Date(), index: true },
    lastError: String,
    deliveredAt: Date,
  },
  { timestamps: true, collection: 'outboxevents' },
);

outboxSchema.index({ status: 1, nextAttemptAt: 1 });

export const OutboxEventModel: Model<OutboxEventShape> =
  (mongoose.models.OutboxEvent as Model<OutboxEventShape> | undefined) ??
  mongoose.model<OutboxEventShape>('OutboxEvent', outboxSchema);
