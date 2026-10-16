import mongoose, { Schema, type Model } from 'mongoose';
import type { CustomerSessionShape, StaffSessionShape } from './session.types.js';

const deviceSchema = new Schema(
  {
    id: String,
    platform: String,
    name: String,
    pushToken: String,
    userAgent: { type: String, maxlength: 512 },
    ip: String,
    location: String,
  },
  { _id: false, id: false },
);

const SEVEN_DAYS = 7 * 24 * 60 * 60;

const customerSessionSchema = new Schema<CustomerSessionShape>(
  {
    publicId: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    client: { type: String, enum: ['mobile', 'web'], required: true },
    familyId: { type: String, required: true, index: true },
    device: { type: deviceSchema, default: () => ({}) },
    refreshTokenHash: { type: String, required: true },
    previousHashes: { type: [String], default: [] },
    gracePreviousHash: String,
    graceUntil: Date,
    rotationCount: { type: Number, default: 0 },
    revokedAt: Date,
    revokedReason: String,
    absoluteExpiresAt: { type: Date, required: true },
    lastUsedAt: { type: Date, required: true },
  },
  { timestamps: true, minimize: false },
);
customerSessionSchema.index({ userId: 1, revokedAt: 1, absoluteExpiresAt: 1 });
customerSessionSchema.index({ userId: 1, client: 1, 'device.id': 1 });
// Purge a week after the absolute expiry (keeps a short audit trail of expired sessions).
customerSessionSchema.index({ absoluteExpiresAt: 1 }, { expireAfterSeconds: SEVEN_DAYS });

const staffSessionSchema = new Schema<StaffSessionShape>(
  {
    publicId: { type: String, required: true, unique: true },
    staffId: { type: Schema.Types.ObjectId, ref: 'StaffUser', required: true, index: true },
    sessionTokenHash: { type: String, required: true, unique: true },
    csrfTokenHash: { type: String, required: true },
    state: { type: String, enum: ['active', 'locked'], default: 'active' },
    idleExpiresAt: { type: Date, required: true },
    absoluteExpiresAt: { type: Date, required: true },
    lockedAt: Date,
    failedUnlockCount: { type: Number, default: 0 },
    device: { type: deviceSchema, default: () => ({}) },
    lastUsedAt: { type: Date, required: true },
    revokedAt: Date,
    revokedReason: String,
  },
  { timestamps: true, minimize: false },
);
staffSessionSchema.index({ staffId: 1, revokedAt: 1, absoluteExpiresAt: 1 });
staffSessionSchema.index({ absoluteExpiresAt: 1 }, { expireAfterSeconds: SEVEN_DAYS });

export const CustomerSessionModel: Model<CustomerSessionShape> =
  (mongoose.models.CustomerSession as Model<CustomerSessionShape> | undefined) ??
  mongoose.model<CustomerSessionShape>('CustomerSession', customerSessionSchema);

export const StaffSessionModel: Model<StaffSessionShape> =
  (mongoose.models.StaffSession as Model<StaffSessionShape> | undefined) ??
  mongoose.model<StaffSessionShape>('StaffSession', staffSessionSchema);
