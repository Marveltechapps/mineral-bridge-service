import mongoose, { Schema, type Model, type Types } from 'mongoose';

export interface PasswordResetTokenShape {
  staffId: Types.ObjectId;
  /** sha256 of the emailed token; the token itself is never stored. */
  tokenHash: string;
  expiresAt: Date;
  usedAt?: Date;
  requestedIp?: string;
  createdAt: Date;
}

const passwordResetTokenSchema = new Schema<PasswordResetTokenShape>(
  {
    staffId: { type: Schema.Types.ObjectId, ref: 'StaffUser', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: Date,
    requestedIp: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
// Keep spent/expired rows a day for forensics, then let Mongo drop them.
passwordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

export const PasswordResetTokenModel: Model<PasswordResetTokenShape> =
  (mongoose.models.PasswordResetToken as Model<PasswordResetTokenShape> | undefined) ??
  mongoose.model<PasswordResetTokenShape>('PasswordResetToken', passwordResetTokenSchema);
