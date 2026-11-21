import type { Types } from 'mongoose';

export type KycDocKind =
  | 'id_front'
  | 'id_back'
  | 'selfie'
  | 'proof_of_address'
  | 'business_registration';
export type KycQualityIssue = 'glare' | 'blur' | 'cropped' | 'too_dark' | 'low_resolution';
export type KycSource = 'mobile' | 'web';

/**
 * Submission lifecycle (canonical):
 *   draft → pending → in_review → verified | rejected | resubmission_required
 * The user-level `kycStatus` is a projection: pending/in_review → `pending`, verified → `verified`,
 * rejected/resubmission_required → `rejected` (resubmission carries `retryAllowed: true`).
 */
export type KycSubmissionStatus =
  | 'draft'
  | 'pending'
  | 'in_review'
  | 'verified'
  | 'rejected'
  | 'resubmission_required';

export const KYC_OPEN_STATUSES: readonly KycSubmissionStatus[] = ['pending', 'in_review'];

export interface KycRejection {
  /** One of the registry codes: `kyc/document-unreadable`, `kyc/selfie-mismatch`, `kyc/id-number-mismatch`, `kyc/id-expired`, … */
  code: string;
  reason: string;
  retryAllowed: boolean;
  hint?: string;
}

export interface KycDocumentShape {
  /** `kdoc_…` */
  publicId: string;
  userId: Types.ObjectId;
  submissionId?: Types.ObjectId;
  kind: KycDocKind;
  idTypeId?: string;
  /** Storage reference (`fil_…`): our own store for mobile uploads, `POST /uploads` for web. */
  fileId: string;
  mimeType?: string;
  sizeBytes?: number;
  originalName?: string;
  quality: { passed: boolean; issues: KycQualityIssue[] };
  liveness?: { passed: boolean; faceDetected: boolean; score: number; reason?: string };
  /** `false` when no automated provider ran — a human reviews everything. */
  automated: boolean;
  source: KycSource;
  discardedAt?: Date;
  /** Compliance decision for this capture. Absent until a reviewer acts. */
  review?: {
    status: 'in_review' | 'verified' | 'rejected';
    reason?: string;
    decidedAt?: Date;
    decidedBy?: string;
  };
  /** Dashboard per-document flag shown to the customer. */
  flag?: { message: string; at: Date; by?: string };
  uploadedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface KycDocumentRecord extends KycDocumentShape {
  id: string;
}

export interface KycSubmissionShape {
  /** `kyc_…` */
  publicId: string;
  /** `KYC-2026-77310`; assigned on submit. */
  reference?: string;
  userId: Types.ObjectId;
  status: KycSubmissionStatus;
  idTypeId?: string;
  /** Full ID number — PII, `select: false`; reviewers load it explicitly. */
  idNumber?: string;
  /** HMAC blind index for duplicate-identity detection. */
  idNumberHash?: string;
  idNumberLast4?: string;
  documentIds: Types.ObjectId[];
  /** Required capture kinds for this submission (v2). */
  requiredKinds?: KycDocKind[];
  requestedTier?: 1 | 2 | 3;
  declaredDetails: { fullName?: string; dateOfBirth?: string };
  consent: { given: boolean; at?: Date; ip?: string };
  source: KycSource;
  /** 1-based count of non-draft submissions by this user (M-18). */
  attemptNumber: number;
  /** Set once the user has used up the automatic retries (> 3 attempts). */
  manualReviewRequired: boolean;
  submittedAt?: Date;
  estimatedDecisionBy?: Date;
  reviewStartedAt?: Date;
  decidedAt?: Date;
  /** Staff public id (`STF-…` / `AD-…`). */
  decidedBy?: string;
  /** SLA deadline for review. */
  slaDueAt?: Date;
  rejection?: KycRejection;
  requestedDocuments?: { kind: KycDocKind; reason?: string; at: Date; by?: string }[];
  history?: {
    action: string;
    actor: { kind: string; id: string; name?: string; role?: string };
    at: Date;
    reason?: string;
  }[];
  reviewNotes?: string;
  notifyOnDecision: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface KycSubmissionRecord extends KycSubmissionShape {
  id: string;
}

/** After this many attempts the account goes to manual review (M-18 default). */
export const KYC_AUTO_RETRY_LIMIT = 3;
/** Mobile `estimatedClearanceHours`. */
export const KYC_MOBILE_CLEARANCE_HOURS = 2;
/** Web `reviewSlaHours`. Will be read from Platform Settings `kyc_review_sla_hours` (#131) later. */
export const KYC_WEB_REVIEW_SLA_HOURS = 24;
