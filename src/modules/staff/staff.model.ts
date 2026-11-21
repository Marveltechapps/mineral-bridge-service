import mongoose, { Schema, type Model } from 'mongoose';
import { ACCESS_LEVELS, PERMISSION_MODULES, type StaffShape } from './staff.types.js';

const permissionPaths = Object.fromEntries(
  PERMISSION_MODULES.map((m) => [m, { type: String, enum: ACCESS_LEVELS, default: 'none' }]),
);

const staffSchema = new Schema<StaffShape>(
  {
    publicId: { type: String, required: true, unique: true },
    adminNo: { type: String, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    whatsapp: { type: String, trim: true },
    passwordHash: { type: String, required: true, select: false },
    passwordHistory: { type: [String], default: [], select: false },
    passwordChangedAt: Date,
    phone: { type: String, trim: true },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    desk: { type: String, default: '', trim: true, maxlength: 120 },
    role: {
      id: { type: String, required: true },
      name: { type: String, required: true },
      scope: { type: String, default: '' },
    },
    // Built-in keys plus custom role keys (validated against the role store by the service).
    roleKey: { type: String, trim: true, maxlength: 80 },
    permissions: permissionPaths,
    actions: { type: [String], default: [] },
    actionsOverride: { type: Boolean, default: false },
    mfa: {
      enabled: { type: Boolean, default: true },
      channels: { type: [String], default: [] },
    },
    disabled: { type: Boolean, default: false, index: true },
    disabledAt: Date,
    deletedAt: Date,
    deletedBy: String,
    deletedEmail: String,
    invitedBy: String,
    invitedAt: Date,
    notificationPreferences: { type: Schema.Types.Mixed, default: {} },
    ssoSubject: { type: String, index: true, sparse: true },
    lastLoginAt: Date,
  },
  { timestamps: true, minimize: false },
);

staffSchema.index({ adminNo: 1 }, { unique: true, sparse: true });
staffSchema.index({ whatsapp: 1 }, { unique: true, sparse: true });
staffSchema.index({ roleKey: 1 });

export const StaffModel: Model<StaffShape> =
  (mongoose.models.StaffUser as Model<StaffShape> | undefined) ??
  mongoose.model<StaffShape>('StaffUser', staffSchema);
