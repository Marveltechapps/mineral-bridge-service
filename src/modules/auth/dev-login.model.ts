import mongoose, { Schema, type Model } from 'mongoose';

export type DevLoginAudience = 'app' | 'admin';

export interface DevelopmentPrincipalShape {
  audience: DevLoginAudience;
  email: string;
  subjectType: 'user' | 'staff';
  subjectId: string;
  createdAt: Date;
  updatedAt: Date;
}

const principalSchema = new Schema<DevelopmentPrincipalShape>(
  {
    audience: { type: String, enum: ['app', 'admin'], required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    subjectType: { type: String, enum: ['user', 'staff'], required: true },
    subjectId: { type: String, required: true },
  },
  { timestamps: true },
);
principalSchema.index({ audience: 1, email: 1 }, { unique: true });

export const DevelopmentPrincipalModel: Model<DevelopmentPrincipalShape> =
  (mongoose.models.DevelopmentPrincipal as Model<DevelopmentPrincipalShape> | undefined) ??
  mongoose.model<DevelopmentPrincipalShape>('DevelopmentPrincipal', principalSchema);

export interface DevLoginAttemptShape {
  key: string;
  at: Date;
}

const ATTEMPT_TTL_SECONDS = 15 * 60;

const attemptSchema = new Schema<DevLoginAttemptShape>(
  {
    key: { type: String, required: true },
    at: { type: Date, required: true },
  },
  { minimize: false },
);
attemptSchema.index({ key: 1, at: 1 });
attemptSchema.index({ at: 1 }, { expireAfterSeconds: ATTEMPT_TTL_SECONDS });

export const DevLoginAttemptModel: Model<DevLoginAttemptShape> =
  (mongoose.models.DevLoginAttempt as Model<DevLoginAttemptShape> | undefined) ??
  mongoose.model<DevLoginAttemptShape>('DevLoginAttempt', attemptSchema);

export const DEV_LOGIN_ATTEMPT_WINDOW_MS = ATTEMPT_TTL_SECONDS * 1000;
