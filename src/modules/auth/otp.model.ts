import mongoose, { Schema, type Model } from 'mongoose';

export type OtpClient = 'mobile' | 'web' | 'admin';
export type OtpIntent = 'signup' | 'login' | 'staff_login';
export type OtpChannel = 'sms' | 'voice' | 'whatsapp' | 'email';

export interface OtpChallengeShape {
  /** `chl_…` — public handle. */
  challengeId: string;
  /** Challenges are never valid across clients (W-9). */
  client: OtpClient;
  intent: OtpIntent;
  channel: OtpChannel;
  /** Normalised E.164 phone or lower-cased email. */
  destination: string;
  maskedDestination: string;
  /** HMAC-SHA256(server secret, challengeId:code). The code itself is never stored. */
  codeHash: string;
  codeLength: number;
  expiresAt: Date;
  attempts: number;
  maxAttempts: number;
  sendCount: number;
  lastSentAt: Date;
  resendAvailableAt: Date;
  consumedAt?: Date;
  /** Set when `attempts >= maxAttempts`. */
  lockedAt?: Date;
  subjectType?: 'user' | 'staff';
  subjectId?: string;
  /** Web login against an unknown identifier: no code is sent and verify always fails (anti-enumeration). */
  decoy: boolean;
  /** Client-specific carry-over, e.g. web registration fields or admin `returnTo`. */
  payload?: Record<string, unknown>;
  /** TTL anchor — documents are purged an hour after expiry. */
  purgeAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface OtpChallengeRecord extends OtpChallengeShape {
  id: string;
}

const otpChallengeSchema = new Schema<OtpChallengeShape>(
  {
    challengeId: { type: String, required: true, unique: true },
    client: { type: String, enum: ['mobile', 'web', 'admin'], required: true },
    intent: { type: String, enum: ['signup', 'login', 'staff_login'], required: true },
    channel: { type: String, enum: ['sms', 'voice', 'whatsapp', 'email'], required: true },
    destination: { type: String, required: true },
    maskedDestination: { type: String, required: true },
    codeHash: { type: String, required: true, select: false },
    codeLength: { type: Number, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, required: true },
    sendCount: { type: Number, default: 1 },
    lastSentAt: { type: Date, required: true },
    resendAvailableAt: { type: Date, required: true },
    consumedAt: Date,
    lockedAt: Date,
    subjectType: { type: String, enum: ['user', 'staff'] },
    subjectId: String,
    decoy: { type: Boolean, default: false },
    payload: { type: Schema.Types.Mixed },
    purgeAt: { type: Date, required: true },
  },
  { timestamps: true, minimize: false },
);
otpChallengeSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export const OtpChallengeModel: Model<OtpChallengeShape> =
  (mongoose.models.OtpChallenge as Model<OtpChallengeShape> | undefined) ??
  mongoose.model<OtpChallengeShape>('OtpChallenge', otpChallengeSchema);

/**
 * One row per send attempt, keyed by a hash of the destination or IP. Counting rows in the last
 * 15 minutes gives the throttle (`OTP_MAX_PER_PHONE_15MIN`, `OTP_MAX_PER_IP_15MIN`). Rows expire
 * on their own, so no cleanup job is needed.
 */
export interface OtpSendLogShape {
  key: string;
  kind: 'destination' | 'ip';
  client: OtpClient;
  at: Date;
}

const OTP_THROTTLE_WINDOW_SECONDS = 15 * 60;

const otpSendLogSchema = new Schema<OtpSendLogShape>(
  {
    key: { type: String, required: true, index: true },
    kind: { type: String, enum: ['destination', 'ip'], required: true },
    client: { type: String, enum: ['mobile', 'web', 'admin'], required: true },
    at: { type: Date, required: true, default: () => new Date() },
  },
  { minimize: false },
);
otpSendLogSchema.index({ at: 1 }, { expireAfterSeconds: OTP_THROTTLE_WINDOW_SECONDS });

export const OtpSendLogModel: Model<OtpSendLogShape> =
  (mongoose.models.OtpSendLog as Model<OtpSendLogShape> | undefined) ??
  mongoose.model<OtpSendLogShape>('OtpSendLog', otpSendLogSchema);

export const OTP_THROTTLE_WINDOW_MS = OTP_THROTTLE_WINDOW_SECONDS * 1000;
