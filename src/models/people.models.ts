import { Schema } from 'mongoose';
import { defineModel, timestampFields } from '../common/db/define-model.js';
import { ACCOUNT_STATUSES, DISPUTE_OUTCOMES, DISPUTE_STATUSES, DOC_STATUSES, KYC_STATUSES } from '../modules/admin/shared/enums.js';
import { moneySchema, refSchema } from './shared.js';

const opts = { timestamps: true } as const;

/** Customer account (mobile + web + admin oversight). Admin reads/manages; customer apps own sign-up. */
const userSchema = new Schema<any>(
  {
    userId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    org: { type: String, default: '' },
    email: { type: String, lowercase: true, trim: true, index: true },
    phone: { type: String, index: true },
    contactName: String,
    tier: { type: Number, enum: [1, 2, 3], default: 1, index: true },
    status: { type: String, enum: ACCOUNT_STATUSES, default: 'in_review', index: true },
    kycStatus: { type: String, enum: ['none', 'pending', 'verified', 'rejected'], default: 'none' },
    country: { type: String, default: 'KE' },
    ...timestampFields,
  },
  opts,
);
userSchema.index({ name: 'text', org: 'text' });
export const User = defineModel('User', userSchema, 'users');

const tierRequestSchema = new Schema<any>(
  {
    requestId: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    from: { type: Number, enum: [1, 2, 3], required: true },
    to: { type: Number, enum: [1, 2, 3], required: true },
    reason: String,
    raisedBy: String,
    status: { type: String, enum: ['pending', 'approved', 'denied'], default: 'pending', index: true },
    decidedBy: String,
    decidedAt: Date,
    decisionReason: String,
    kycId: String,
    openedAt: { type: Date, default: Date.now },
    ...timestampFields,
  },
  opts,
);
tierRequestSchema.index({ userId: 1 }, { unique: true, partialFilterExpression: { status: 'pending' } });
export const TierRequest = defineModel('TierRequest', tierRequestSchema, 'tier_requests');

const kycSchema = new Schema<any>(
  {
    kycId: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    person: String,
    org: String,
    tier: { type: Number, enum: [1, 2, 3], required: true },
    submittedAt: { type: Date, default: Date.now },
    slaDueAt: Date,
    status: { type: String, enum: KYC_STATUSES, default: 'in_review', index: true },
    history: [{ _id: false, action: String, actorId: String, at: Date, reason: String }],
    decidedBy: String,
    decidedAt: Date,
    ...timestampFields,
  },
  opts,
);
export const KycSubmission = defineModel('KycSubmission', kycSchema, 'kyc_submissions');

const kycDocSchema = new Schema<any>(
  {
    docId: { type: String, required: true, unique: true },
    kycId: { type: String, index: true },
    userId: { type: String, required: true, index: true },
    type: { type: String, required: true },
    name: String,
    ref: String,
    tier: { type: Number, enum: [1, 2, 3], default: 1 },
    status: { type: String, enum: DOC_STATUSES, default: 'in_review', index: true },
    expiresOn: { type: Date, index: true },
    fileId: String,
    rejectionReason: String,
    ...timestampFields,
  },
  opts,
);
export const KycDocument = defineModel('KycDocument', kycDocSchema, 'kyc_documents');

const disputeSchema = new Schema<any>(
  {
    disputeId: { type: String, required: true, unique: true },
    linked: refSchema,
    type: { type: String, default: 'general' },
    partyId: String,
    status: { type: String, enum: DISPUTE_STATUSES, default: 'evidence_review', index: true },
    openedAt: { type: Date, default: Date.now },
    valueAtRisk: moneySchema,
    attachmentFileIds: [String],
    messages: [
      {
        _id: false,
        id: String,
        from: { type: String, enum: ['counterparty', 'admin'] },
        author: String,
        text: String,
        at: Date,
        attachmentFileIds: [String],
      },
    ],
    resolution: {
      outcome: { type: String, enum: DISPUTE_OUTCOMES },
      adjustment: moneySchema,
      note: String,
      recordedBy: String,
      recordedAt: Date,
      settlementId: String,
    },
    escalatedAt: Date,
    /** Staff who raised the dispute (if staff-raised) — blocked from recording the resolution (four-eyes). */
    createdBy: String,
    raisedBy: { kind: { type: String, enum: ['staff', 'user', 'system'] }, id: String },
    ...timestampFields,
  },
  opts,
);
export const Dispute = defineModel('Dispute', disputeSchema, 'disputes');
