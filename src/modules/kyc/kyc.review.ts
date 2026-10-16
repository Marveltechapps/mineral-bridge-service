import { isValidObjectId } from 'mongoose';
import { conflict, notFound } from '../../common/errors/app-error.js';
import { applyKycStatus } from '../users/user.service.js';
import { kycEvents } from './kyc.events.js';
import { KycSubmissionModel } from './kyc.model.js';
import {
  KYC_OPEN_STATUSES,
  type KycRejection,
  type KycSubmissionRecord,
  type KycSubmissionShape,
} from './kyc.types.js';

/**
 * Shared review logic. The admin Compliance module (#97/#98/#100…) calls these after it has
 * checked `compliance:edit`; nothing here knows about HTTP or permissions.
 */

export type ReviewDecision =
  | { type: 'approve'; notes?: string }
  | { type: 'reject'; rejection: Omit<KycRejection, 'retryAllowed'> & { retryAllowed?: boolean }; notes?: string }
  /** Ask the customer to re-upload: stored as `resubmission_required`, shown to clients as `rejected` + `retryAllowed`. */
  | { type: 'request_resubmission'; rejection: Omit<KycRejection, 'retryAllowed'>; notes?: string };

type WithId<T> = T & { _id: { toString(): string } };

function toRecord(raw: WithId<KycSubmissionShape> | null): KycSubmissionRecord | null {
  if (!raw) return null;
  const { _id, ...rest } = raw as WithId<KycSubmissionShape> & Record<string, unknown>;
  return { ...(rest as unknown as KycSubmissionShape), id: _id.toString() };
}

/** `kyc_…` public id, `KYC-…` reference or ObjectId. Includes the PII-bearing `idNumber` for reviewers. */
export async function findSubmissionForReview(idOrReference: string): Promise<KycSubmissionRecord | null> {
  const or: Array<Record<string, string>> = [{ publicId: idOrReference }, { reference: idOrReference }];
  if (isValidObjectId(idOrReference)) or.push({ _id: idOrReference });
  return toRecord(
    await KycSubmissionModel.findOne({ $or: or, status: { $ne: 'draft' } })
      .select('+idNumber')
      .lean<WithId<KycSubmissionShape>>(),
  );
}

/** pending → in_review (a reviewer opened it). Idempotent. */
export async function markInReview(idOrReference: string, now = new Date()) {
  const sub = await findSubmissionForReview(idOrReference);
  if (!sub) throw notFound('resource/not-found', 'KYC submission not found');
  if (sub.status !== 'pending') return sub;
  const updated = await KycSubmissionModel.findOneAndUpdate(
    { _id: sub.id, status: 'pending' },
    { $set: { status: 'in_review', reviewStartedAt: now } },
    { new: true },
  ).lean<WithId<KycSubmissionShape>>();
  return toRecord(updated) ?? sub;
}

/**
 * Records a decision and projects it onto the user (`kycStatus`, verified identity, tier).
 * The status guard in the update makes a double decision a `409 conflict/stale-state`
 * instead of silently overwriting the first one.
 */
export async function decideSubmission(input: {
  submission: string;
  staffPublicId: string;
  decision: ReviewDecision;
  now?: Date;
}): Promise<KycSubmissionRecord> {
  const now = input.now ?? new Date();
  const sub = await findSubmissionForReview(input.submission);
  if (!sub) throw notFound('resource/not-found', 'KYC submission not found');

  const stale = () =>
    conflict('conflict/stale-state', `${sub.reference ?? sub.publicId} has already been decided.`, {
      details: { currentStatus: sub.status },
    });
  if (!KYC_OPEN_STATUSES.includes(sub.status)) throw stale();

  const { decision } = input;
  let status: 'verified' | 'rejected' | 'resubmission_required';
  let rejection: KycRejection | undefined;
  if (decision.type === 'approve') {
    status = 'verified';
  } else if (decision.type === 'reject') {
    status = 'rejected';
    rejection = { ...decision.rejection, retryAllowed: decision.rejection.retryAllowed ?? true };
  } else {
    status = 'resubmission_required';
    rejection = { ...decision.rejection, retryAllowed: true };
  }

  const updated = await KycSubmissionModel.findOneAndUpdate(
    { _id: sub.id, status: { $in: [...KYC_OPEN_STATUSES] } },
    {
      $set: {
        status,
        decidedAt: now,
        decidedBy: input.staffPublicId,
        ...(decision.notes ? { reviewNotes: decision.notes } : {}),
        ...(rejection ? { rejection } : {}),
      },
    },
    { new: true },
  ).lean<WithId<KycSubmissionShape>>();
  if (!updated) throw stale();
  const decided = toRecord(updated)!;

  await applyKycStatus(
    decided.userId.toString(),
    status === 'verified'
      ? {
          status: 'verified',
          reference: decided.reference,
          submissionId: decided.id,
          verifiedAt: now,
          // "Taken from your verified ID" — these fields become padlocked on the profile.
          verifiedIdentity: decided.declaredDetails,
          tier: decided.requestedTier,
        }
      : {
          status: 'rejected',
          reference: decided.reference,
          submissionId: decided.id,
          verifiedAt: null,
        },
  );

  kycEvents.emit('kyc.decided', {
    userId: decided.userId.toString(),
    submissionId: decided.id,
    reference: decided.reference,
    status,
    rejection,
    decidedBy: input.staffPublicId,
    notifyOnDecision: decided.notifyOnDecision,
  });
  return decided;
}
