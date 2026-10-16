import { Schema } from 'mongoose';
import { defineModel, timestampFields } from '../common/db/define-model.js';
import { refSchema } from './shared.js';

const opts = { timestamps: true } as const;

/** Stored document / image metadata. Bytes live in the storage driver (local disk or S3). */
const fileSchema = new Schema<any>(
  {
    fileId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    mimeType: { type: String, default: 'application/octet-stream' },
    sizeBytes: { type: Number, default: 0 },
    storageKey: { type: String, required: true },
    /** Owning record → decides which module permission is needed to open it (#17). */
    owner: refSchema,
    uploadedBy: String,
    uploadedAt: { type: Date, default: Date.now },
    ...timestampFields,
  },
  opts,
);
export const FileObject = defineModel('FileObject', fileSchema, 'files');

/** Staff "needs attention" bell. `module` scopes visibility to staff with view access on that module. */
const staffNotificationSchema = new Schema<any>(
  {
    notificationId: { type: String, required: true, unique: true },
    module: { type: String, required: true, index: true },
    text: { type: String, required: true },
    meta: String,
    severity: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
    target: refSchema,
    /** null = broadcast to everyone with module access */
    staffId: { type: String, default: null },
    readBy: [String],
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false },
);
export const StaffNotification = defineModel('StaffNotification', staffNotificationSchema, 'staff_notifications');

/** Overview "Recent activity" feed (written together with audit rows). */
const activitySchema = new Schema<any>(
  {
    activityId: { type: String, required: true, unique: true },
    text: { type: String, required: true },
    meta: String,
    kind: { type: String, default: 'system' },
    severity: { type: String, enum: ['info', 'warn', 'error'], default: 'info' },
    ref: refSchema,
    at: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false },
);
export const ActivityEvent = defineModel('ActivityEvent', activitySchema, 'activity_events');

/** SMS / in-app messages sent to customers by staff (orders, users). */
const outboundMessageSchema = new Schema<any>(
  {
    messageId: { type: String, required: true, unique: true },
    toUserId: { type: String, required: true, index: true },
    subject: String,
    body: { type: String, required: true },
    channels: [String],
    deliveredVia: [String],
    failedChannels: [{ _id: false, channel: String, code: String }],
    status: { type: String, enum: ['draft', 'sent', 'failed'], default: 'sent' },
    related: refSchema,
    sentBy: String,
    ...timestampFields,
  },
  opts,
);
export const OutboundMessage = defineModel('OutboundMessage', outboundMessageSchema, 'outbound_messages');

/** Versioned settings documents: `roles` (etag only), `platform` (values), `btc` (etag only). */
const settingsSchema = new Schema<any>(
  {
    key: { type: String, required: true, unique: true },
    values: { type: Schema.Types.Mixed, default: {} },
    version: { type: Number, default: 1 },
    updatedBy: String,
    ...timestampFields,
  },
  opts,
);
export const SettingsDoc = defineModel('SettingsDoc', settingsSchema, 'settings');

const exportJobSchema = new Schema<any>(
  {
    exportId: { type: String, required: true, unique: true },
    kind: { type: String, enum: ['audit_log', 'orders'], required: true },
    format: { type: String, enum: ['csv', 'jsonl'], default: 'csv' },
    filters: Schema.Types.Mixed,
    status: { type: String, enum: ['queued', 'running', 'ready', 'failed'], default: 'queued', index: true },
    requestedBy: String,
    rowCount: Number,
    storageKey: String,
    error: String,
    notifiedAt: Date,
    ...timestampFields,
  },
  opts,
);
export const ExportJob = defineModel('ExportJob', exportJobSchema, 'export_jobs');

const idempotencySchema = new Schema<any>(
  {
    scope: { type: String, required: true, unique: true },
    bodyHash: { type: String, required: true },
    state: { type: String, enum: ['in_progress', 'completed'], default: 'in_progress' },
    status: Number,
    body: Schema.Types.Mixed,
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { versionKey: false },
);
export const IdempotencyRecord = defineModel('IdempotencyRecord', idempotencySchema, 'idempotency_keys');
