import { toWebKycStatus } from '../users/user.service.js';
import type { UserRecord } from '../users/user.types.js';
import { getIdType, requiredWebSides, reviewDocumentName, reviewDocumentSide, type KycIdType } from './kyc.id-types.js';
import {
  deriveWebStage,
  webSideForKind,
  type KycView,
} from './kyc.service.js';
import {
  KYC_MOBILE_CLEARANCE_HOURS,
  KYC_WEB_REVIEW_SLA_HOURS,
  type KycDocumentRecord,
  type KycSubmissionRecord,
} from './kyc.types.js';

const iso = (d: Date | undefined | null): string | null => (d ? d.toISOString() : null);

// =============================================================================================
// Mobile (`/kyc/*`)
// =============================================================================================

type StepState = 'done' | 'active' | 'pending';

function mobileSteps(user: Pick<UserRecord, 'kycStatus'>) {
  const state = (a: StepState, b: StepState, c: StepState) => [
    {
      key: 'documents_received',
      title: 'Documents received',
      sub: 'ID and selfie uploaded successfully.',
      state: a,
    },
    {
      key: 'database_check',
      title: 'Identity database check',
      sub: 'Name, DOB and number matched against NIMC.',
      state: b,
    },
    {
      key: 'approved',
      title: 'Account approved',
      sub: 'Ordering, listing and bidding unlock automatically.',
      state: c,
    },
  ];
  switch (user.kycStatus) {
    case 'pending':
      return state('done', 'active', 'pending');
    case 'verified':
      return state('done', 'done', 'done');
    case 'rejected':
      return state('done', 'done', 'pending');
    default:
      return state('pending', 'pending', 'pending');
  }
}

/** Mobile #22 / #26. Status vocabulary is canonical (`none | pending | verified | rejected`). */
export function toMobileKycStatus(user: UserRecord, submission: KycSubmissionRecord | null) {
  const decided = user.kycStatus === 'rejected' ? submission?.rejection : undefined;
  return {
    status: user.kycStatus,
    reference: submission?.reference ?? user.kycReference ?? null,
    submittedAt: iso(submission?.submittedAt),
    estimatedClearanceHours: user.kycStatus === 'pending' ? KYC_MOBILE_CLEARANCE_HOURS : null,
    steps: mobileSteps(user),
    rejection: decided
      ? {
          reason: decided.reason,
          code: decided.code,
          retryAllowed: decided.retryAllowed,
          hint: decided.hint ?? null,
        }
      : null,
  };
}

export function toMobileKycDocument(doc: KycDocumentRecord) {
  return {
    id: doc.publicId,
    kind: doc.kind,
    quality: {
      passed: doc.quality.passed,
      glare: doc.quality.issues.includes('glare'),
      blur: doc.quality.issues.includes('blur'),
      cornersVisible: !doc.quality.issues.includes('cropped'),
    },
    ...(doc.liveness
      ? {
          liveness: {
            passed: doc.liveness.passed,
            faceDetected: doc.liveness.faceDetected,
            score: doc.liveness.score,
          },
        }
      : {}),
    uploadedAt: doc.uploadedAt.toISOString(),
  };
}

export function toMobileIdType(t: KycIdType) {
  return {
    id: t.id,
    name: t.name,
    shortLabel: t.shortLabel,
    hint: t.hint,
    numberFormat: t.numberFormat,
    requiresBack: t.requiresBack,
  };
}

export function unreadableHint(issues: readonly string[]): string {
  if (issues.includes('glare')) return 'Move away from direct light and retake the photo.';
  if (issues.includes('blur')) return 'Hold steady and let the camera focus before capturing.';
  if (issues.includes('cropped')) return 'Make sure all four corners of the document are inside the frame.';
  if (issues.includes('too_dark')) return 'Retake the photo in better light.';
  return 'Retake the photo on a flat, dark surface in even light.';
}

// =============================================================================================
// Web (`/kyc`)
// =============================================================================================

function reviewStatus(
  userStatus: string,
  latest: KycView['latest'],
  doc: KycDocumentRecord,
): 'verified' | 'rejected' | 'in_review' | 'uploaded' {
  if (doc.review?.status) return doc.review.status;
  if (userStatus === 'verified' || latest?.status === 'verified') return 'verified';
  if (userStatus === 'rejected' || latest?.status === 'rejected' || latest?.status === 'resubmission_required') return 'rejected';
  if (userStatus === 'pending' || latest?.status === 'pending' || latest?.status === 'in_review') return 'in_review';
  return 'uploaded';
}

/** Web `GET /kyc` / `PATCH /kyc` record. `none` is presented as `unverified` (W-4). */
export function toWebKycRecord(view: KycView) {
  const { user, latest, active, documents, feedbackDocuments } = view;
  const idType: KycIdType | undefined = getIdType(active?.idTypeId ?? latest?.idTypeId);
  const stage = deriveWebStage(user.kycStatus, idType, documents);

  // Only acceptable captures count; an unacceptable one leaves its slot pending on the client.
  const captures = documents
    .filter((d) => d.kind !== 'selfie' && d.quality.passed)
    .map((d) => ({
      side: webSideForKind(d.kind, idType),
      fileId: d.fileId,
      capturedAt: d.uploadedAt.toISOString(),
    }));

  const selfieDoc = documents.find((d) => d.kind === 'selfie' && d.quality.passed && d.liveness?.passed !== false);
  const rejected = user.kycStatus === 'rejected' || latest?.status === 'resubmission_required' ? latest?.rejection : undefined;
  const shown = feedbackDocuments.length > 0 ? feedbackDocuments : documents;

  return {
    status: toWebKycStatus(user.kycStatus),
    stage,
    idType: idType?.webId ?? null,
    requiredSides: requiredWebSides(idType),
    captures,
    selfie: selfieDoc ? { fileId: selfieDoc.fileId, capturedAt: selfieDoc.uploadedAt.toISOString() } : null,
    submittedAt: iso(latest?.submittedAt),
    decidedAt: iso(latest?.decidedAt),
    rejectionReason: rejected?.reason ?? null,
    retryAllowed: rejected?.retryAllowed ?? null,
    resubmissionRequired: latest?.status === 'resubmission_required',
    documents: shown.map((doc) => {
      const status = reviewStatus(user.kycStatus, latest, doc);
      return {
        kind: doc.kind,
        side: reviewDocumentSide(doc.kind, idType?.id),
        name: reviewDocumentName(doc.kind, idType?.id),
        fileId: doc.fileId,
        status,
        rejectionReason: status === 'rejected' ? doc.review?.reason ?? rejected?.reason ?? null : null,
      };
    }),
    reviewSlaHours: KYC_WEB_REVIEW_SLA_HOURS,
    reference: latest?.reference ?? user.kycReference ?? null,
  };
}

export function toWebCaptureResponse(doc: KycDocumentRecord, idType: KycIdType | undefined) {
  return {
    side: webSideForKind(doc.kind, idType),
    fileId: doc.fileId,
    capturedAt: doc.uploadedAt.toISOString(),
    quality: { acceptable: doc.quality.passed, issues: doc.quality.issues },
  };
}

export function toWebSelfieResponse(doc: KycDocumentRecord) {
  return {
    capturedAt: doc.uploadedAt.toISOString(),
    liveness: {
      passed: doc.liveness?.passed ?? doc.quality.passed,
      score: doc.liveness?.score ?? 0,
      reason: doc.liveness?.reason ?? null,
    },
  };
}
