import mongoose, { Schema, type Model } from 'mongoose';
import {
  CURRENCY_PREFS,
  KYC_STATUSES,
  LANGUAGES,
  TIERS,
  USER_ROLES,
  type UserShape,
} from './user.types.js';

const addressSchema = new Schema(
  {
    id: { type: String, required: true },
    kind: { type: String, enum: ['pickup', 'delivery'], required: true },
    label: { type: String, required: true, trim: true, maxlength: 120 },
    streetAddress: { type: String, required: true, trim: true, maxlength: 240 },
    city: { type: String, required: true, trim: true, maxlength: 120 },
    region: { type: String, required: true, trim: true, maxlength: 120 },
    country: { type: String, required: true, uppercase: true, length: 2, default: 'NG' },
    org: { type: String, trim: true, maxlength: 160 },
    contactPerson: { type: String, trim: true, maxlength: 120 },
    contactPhone: { type: String, trim: true, maxlength: 20 },
    isDefault: { type: Boolean, default: false },
    importPermitNumber: { type: String, trim: true, maxlength: 60 },
    source: { type: String, enum: ['profile', 'manual'], default: 'manual' },
    geo: { type: new Schema({ lat: Number, lng: Number }, { _id: false }), default: undefined },
    savedAt: { type: Date, default: () => new Date() },
  },
  { _id: false, id: false },
);

const userSchema = new Schema<UserShape>(
  {
    // `unique + sparse`: users without a phone (web email sign-ups) or without an email
    // (mobile sign-ups) never collide. Services must leave these fields *undefined*, never null.
    customerNo: { type: String, trim: true },
    phone: { type: String, trim: true },
    phoneVerifiedAt: Date,
    whatsapp: { type: String, trim: true },
    whatsappVerifiedAt: Date,
    email: { type: String, trim: true, lowercase: true },
    emailVerifiedAt: Date,
    signInMethod: { type: String, enum: ['whatsapp', 'sms', 'email'] },

    passwordHash: { type: String, select: false },
    passwordChangedAt: Date,

    roles: {
      type: [{ type: String, enum: USER_ROLES }],
      default: ['both'],
      validate: (v: string[]) => v.length > 0,
    },

    business: {
      buyerType: {
        type: String,
        enum: ['refinery', 'house', 'industry', 'jewel', 'investor', 'wholesale'],
      },
      sellerType: {
        type: String,
        enum: ['asm', 'industrial', 'coop', 'dealer', 'form', 'exporter', 'scrap'],
      },
      name: { type: String, trim: true, maxlength: 160 },
      registrationNo: { type: String, trim: true, maxlength: 60 },
    },

    kycStatus: { type: String, enum: KYC_STATUSES, default: 'none', index: true },
    kycReference: String,
    kycVerifiedAt: Date,
    kycSubmissionId: { type: Schema.Types.ObjectId, ref: 'KycSubmission' },

    tier: { type: Number, enum: TIERS, default: 1 },
    tierChosenAt: Date,

    accountStatus: {
      type: String,
      enum: ['active', 'suspended', 'closed'],
      default: 'active',
    },
    suspension: {
      type: new Schema(
        {
          reason: { type: String, maxlength: 500 },
          at: Date,
          by: { kind: String, id: String, name: String, role: String },
          liftedAt: Date,
          liftedBy: { kind: String, id: String, name: String, role: String },
        },
        { _id: false },
      ),
      default: undefined,
    },

    profile: {
      fullName: { type: String, trim: true, maxlength: 160 },
      displayName: { type: String, trim: true, maxlength: 120 },
      dateOfBirth: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
      avatarUrl: String,
      countryCode: { type: String, uppercase: true, length: 2 },
      companyName: { type: String, trim: true, maxlength: 160 },
      businessRegistrationNumber: { type: String, trim: true, maxlength: 60 },
    },

    preferences: {
      language: { type: String, enum: LANGUAGES, default: 'en' },
      currency: { type: String, enum: CURRENCY_PREFS, default: 'USD' },
      units: { type: String, enum: ['metric', 'imperial'], default: 'metric' },
      alerts: {
        bids: { type: Boolean, default: true },
        orders: { type: Boolean, default: true },
        lots: { type: Boolean, default: true },
        marketing: { type: Boolean, default: false },
      },
      biometric: { type: Boolean, default: false },
    },

    addresses: { type: [addressSchema], default: [] },
    acceptedTerms: { type: new Schema({ version: String, at: Date }, { _id: false }), default: undefined },

    pinHash: { type: String, select: false },
    pinSetAt: Date,
    pinFailCount: { type: Number, default: 0 },
    pinLockedUntil: Date,

    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: Date,
    deletionScheduledAt: { type: Date, index: true, sparse: true },
    deletionReason: String,

    stats: {
      orders: { type: Number, default: 0 },
      sells: { type: Number, default: 0 },
      openOrders: { type: Number, default: 0 },
      lastOrderAt: Date,
    },

    lastLoginAt: Date,
  },
  { timestamps: true, minimize: false },
);

userSchema.index({ phone: 1 }, { unique: true, sparse: true });
userSchema.index({ email: 1 }, { unique: true, sparse: true });
// Unique after M1 backfill — sparse so existing rows without customerNo remain valid.
userSchema.index({ customerNo: 1 }, { unique: true, sparse: true });
userSchema.index({ accountStatus: 1, createdAt: -1 });
userSchema.index({ whatsapp: 1 }, { unique: true, sparse: true });
userSchema.index({ roles: 1, 'business.buyerType': 1 });
userSchema.index({ 'business.sellerType': 1 });
userSchema.index({ 'profile.fullName': 'text', 'business.name': 'text', email: 'text' });

export const UserModel: Model<UserShape> =
  (mongoose.models.User as Model<UserShape> | undefined) ?? mongoose.model<UserShape>('User', userSchema);
