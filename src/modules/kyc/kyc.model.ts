import mongoose, { Schema, type Model } from 'mongoose';
import type { KycDocumentShape, KycSubmissionShape } from './kyc.types.js';

const kycDocumentSchema = new Schema<KycDocumentShape>(
  {
    publicId: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    submissionId: { type: Schema.Types.ObjectId, ref: 'KycSubmission', index: true },
    kind: { type: String, enum: ['id_front', 'id_back', 'selfie'], required: true },
    idTypeId: String,
    fileId: { type: String, required: true, index: true },
    mimeType: String,
    sizeBytes: Number,
    originalName: { type: String, maxlength: 255 },
    quality: {
      passed: { type: Boolean, required: true },
      issues: { type: [String], default: [] },
    },
    liveness: {
      type: new Schema(
        { passed: Boolean, faceDetected: Boolean, score: Number, reason: String },
        { _id: false },
      ),
      default: undefined,
    },
    automated: { type: Boolean, default: false },
    source: { type: String, enum: ['mobile', 'web'], required: true },
    discardedAt: Date,
    uploadedAt: { type: Date, required: true },
  },
  { timestamps: true, minimize: false },
);

const kycSubmissionSchema = new Schema<KycSubmissionShape>(
  {
    publicId: { type: String, required: true, unique: true },
    reference: { type: String, unique: true, sparse: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: {
      type: String,
      enum: ['draft', 'pending', 'in_review', 'verified', 'rejected', 'resubmission_required'],
      required: true,
      index: true,
    },
    idTypeId: String,
    idNumber: { type: String, select: false },
    idNumberLast4: String,
    documentIds: { type: [Schema.Types.ObjectId], default: [] },
    requestedTier: { type: Number, enum: [1, 2, 3] },
    declaredDetails: {
      fullName: String,
      dateOfBirth: String,
    },
    consent: {
      given: { type: Boolean, default: false },
      at: Date,
      ip: String,
    },
    source: { type: String, enum: ['mobile', 'web'], required: true },
    attemptNumber: { type: Number, default: 0 },
    manualReviewRequired: { type: Boolean, default: false },
    submittedAt: Date,
    estimatedDecisionBy: Date,
    reviewStartedAt: Date,
    decidedAt: Date,
    decidedBy: String,
    rejection: {
      type: new Schema(
        { code: String, reason: String, retryAllowed: Boolean, hint: String },
        { _id: false },
      ),
      default: undefined,
    },
    reviewNotes: String,
    notifyOnDecision: { type: Boolean, default: false },
  },
  { timestamps: true, minimize: false },
);

// At most one draft per user (concurrent `ensureDraft` upserts cannot create two).
kycSubmissionSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { status: 'draft' }, name: 'one_draft_per_user' },
);
kycSubmissionSchema.index({ status: 1, submittedAt: 1 }); // reviewer queue

export const KycDocumentModel: Model<KycDocumentShape> =
  (mongoose.models.KycDocument as Model<KycDocumentShape> | undefined) ??
  mongoose.model<KycDocumentShape>('KycDocument', kycDocumentSchema);

export const KycSubmissionModel: Model<KycSubmissionShape> =
  (mongoose.models.KycSubmission as Model<KycSubmissionShape> | undefined) ??
  mongoose.model<KycSubmissionShape>('KycSubmission', kycSubmissionSchema);
