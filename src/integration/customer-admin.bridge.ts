import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { isValidObjectId, Types } from 'mongoose';
import { logger } from '../config/logger.js';
import { AppError } from '../common/errors/app-error.js';
import { loadEnv } from '../config/env.js';
import { FileModel } from '../models/file.model.js';
import { OrderModel } from '../models/order.model.js';
import type { IOrder } from '../models/order.model.js';
import { KycDocument, KycSubmission, User } from '../models/people.models.js';
import { FileObject } from '../models/platform.models.js';
import { Order } from '../models/trading.models.js';
import { ORDER_STAGES, type OrderStage } from '../modules/admin/shared/enums.js';
import { reviewDocumentName, reviewDocumentSide } from '../modules/kyc/kyc.id-types.js';
import { KycDocumentModel, KycSubmissionModel } from '../modules/kyc/kyc.model.js';
import { decideSubmission } from '../modules/kyc/kyc.review.js';
import type { KycDocKind, KycDocumentShape, KycSubmissionRecord, KycSubmissionShape } from '../modules/kyc/kyc.types.js';

/**
 * Projects customer-app records into the admin console collections, and writes
 * admin decisions back onto the customer account.
 *
 * The console and the customer apps use different document shapes. They must
 * still be the same business record: `userId` / `kycId` / `orderId` on the
 * admin side are the customer's id, KYC reference, and order reference.
 */

export interface CustomerAccountProjection {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  org?: string;
  country?: string;
  tier?: number;
  kycStatus?: string;
}

const adminAccountStatus = (kycStatus?: string): string =>
  kycStatus === 'verified' ? 'verified' : kycStatus === 'rejected' ? 'rejected' : 'in_review';

export async function projectCustomerAccount(account: CustomerAccountProjection): Promise<void> {
  const kycStatus = ['none', 'pending', 'verified', 'rejected'].includes(account.kycStatus ?? '')
    ? account.kycStatus
    : 'none';
  await User.updateOne(
    { userId: account.id },
    {
      $set: {
        name: account.name || 'Customer',
        org: account.org ?? '',
        email: account.email,
        phone: account.phone,
        country: account.country ?? 'NG',
        tier: account.tier && [1, 2, 3].includes(account.tier) ? account.tier : 1,
        kycStatus,
      },
      $setOnInsert: { status: adminAccountStatus(kycStatus) },
    },
    { upsert: true },
  );
}

type WithId<T> = T & { _id: { toString(): string } };

function asSubmission(raw: WithId<KycSubmissionShape>): KycSubmissionRecord {
  const { _id, ...rest } = raw;
  return { ...(rest as KycSubmissionShape), id: _id.toString() };
}

const IMAGE_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

/** Copies a customer upload into the admin file register so reviewers can open it. */
export async function mirrorCustomerFileForReview(input: {
  fileId: string;
  userId: string;
  kycId: string;
  name: string;
  mimeType?: string;
}): Promise<{ mimeType?: string } | null> {
  const existing = await FileObject.findOne({ fileId: input.fileId }).lean();
  if (existing?.storageKey) return { mimeType: existing.mimeType };

  const customer = await FileModel.findById(input.fileId).lean();
  if (customer && customer.bytes > 0 && customer.storageKey) {
    await FileObject.updateOne(
      { fileId: input.fileId },
      {
        $set: {
          fileId: input.fileId,
          name: customer.filename || input.name,
          mimeType: customer.contentType || input.mimeType || 'application/octet-stream',
          sizeBytes: customer.bytes,
          storageKey: customer.storageKey,
          owner: { type: 'kyc', id: input.kycId },
          uploadedBy: input.userId,
          uploadedAt: customer.createdAt ?? new Date(),
        },
      },
      { upsert: true },
    );
    return { mimeType: customer.contentType || input.mimeType };
  }

  let root = '';
  try {
    root = loadEnv().STORAGE_LOCAL_ROOT;
  } catch {
    return null;
  }
  for (const ext of Object.keys(IMAGE_EXT)) {
    const storageKey = `kyc/${input.userId}/${input.fileId}.${ext}`;
    const full = path.resolve(root, ...storageKey.split('/'));
    if (!full.startsWith(path.resolve(root) + path.sep) || !existsSync(full)) continue;
    const mimeType = input.mimeType || IMAGE_EXT[ext];
    await FileObject.updateOne(
      { fileId: input.fileId },
      {
        $set: {
          fileId: input.fileId,
          name: `${input.name}.${ext}`,
          mimeType,
          sizeBytes: statSync(full).size,
          storageKey,
          owner: { type: 'kyc', id: input.kycId },
          uploadedBy: input.userId,
          uploadedAt: new Date(),
        },
      },
      { upsert: true },
    );
    return { mimeType };
  }
  return null;
}

/** Makes a customer file resolvable by the admin signed-URL route. */
export async function ensureReviewFile(fileId: string): Promise<boolean> {
  if (await FileObject.exists({ fileId })) return true;
  const [adminDoc, customerDoc, customerFile] = await Promise.all([
    KycDocument.findOne({ fileId }).lean(),
    KycDocumentModel.findOne({ fileId, discardedAt: null }).lean(),
    FileModel.findById(fileId).lean(),
  ]);
  const userId = adminDoc?.userId || customerDoc?.userId?.toString() || customerFile?.ownerId;
  if (!userId) return false;
  const mirrored = await mirrorCustomerFileForReview({
    fileId,
    userId: String(userId),
    kycId: adminDoc?.kycId || customerFile?.refId || 'kyc',
    name: adminDoc?.name || customerFile?.filename || 'Identity document',
    mimeType: customerDoc?.mimeType || customerFile?.contentType,
  });
  return Boolean(mirrored) || Boolean(await FileObject.exists({ fileId }));
}

async function activeCustomerDocs(submissionId: string): Promise<Array<WithId<KycDocumentShape>>> {
  if (!isValidObjectId(submissionId)) return [];
  return KycDocumentModel.find({ submissionId, discardedAt: null }).sort({ uploadedAt: 1 }).lean<Array<WithId<KycDocumentShape>>>();
}

async function writeAdminKycDocuments(
  submission: KycSubmissionRecord,
  existing: Array<Record<string, unknown>>,
): Promise<void> {
  const kycId = submission.reference ?? submission.publicId;
  const userId = submission.userId.toString();
  const docs = await activeCustomerDocs(submission.id);
  if (docs.length === 0) return;

  const inheritedRejected = existing.length > 0 && existing.every((d) => d.status === 'rejected');
  const inheritedReason = existing.find((d) => typeof d.rejectionReason === 'string' && d.rejectionReason)?.rejectionReason;
  const status = inheritedRejected ? 'rejected' : 'in_review';
  const projected: string[] = [];

  for (const doc of docs) {
    const kind = doc.kind as KycDocKind;
    const docId = `${kycId}:${kind}`;
    projected.push(docId);
    const name = reviewDocumentName(kind, submission.idTypeId);
    const mirrored = await mirrorCustomerFileForReview({
      fileId: doc.fileId,
      userId,
      kycId,
      name,
      mimeType: doc.mimeType,
    }).catch(() => null);
    await KycDocument.updateOne(
      { docId },
      {
        $set: {
          kycId,
          userId,
          type: kind,
          name,
          ref: submission.idNumberLast4 ? `ID ····${submission.idNumberLast4}` : doc.publicId,
          side: reviewDocumentSide(kind, submission.idTypeId),
          tier: submission.requestedTier ?? 1,
          status,
          fileId: doc.fileId,
          ...(mirrored?.mimeType || doc.mimeType ? { mimeType: mirrored?.mimeType || doc.mimeType } : {}),
          ...(status === 'rejected' && inheritedReason ? { rejectionReason: inheritedReason } : {}),
        },
        ...(status === 'in_review' ? { $unset: { rejectionReason: '' } } : {}),
      },
      { upsert: true },
    );
  }
  await KycDocument.deleteMany({ kycId, docId: { $nin: projected } });
}

/**
 * Fills in file ids for a queue row that was projected before each capture was copied.
 * Does not reopen a decision that has already been recorded.
 */
export async function backfillAdminKycFiles(kycId: string): Promise<void> {
  const existing = await KycDocument.find({ kycId }).lean();
  if (existing.some((d) => d.fileId)) return;
  const raw = await KycSubmissionModel.findOne({
    status: { $ne: 'draft' },
    $or: [{ reference: kycId }, { publicId: kycId }],
  }).lean<WithId<KycSubmissionShape>>();
  if (!raw) return;
  await writeAdminKycDocuments(asSubmission(raw), existing);
}

export async function projectKycSubmission(submission: KycSubmissionRecord, person?: string): Promise<void> {
  const kycId = submission.reference ?? submission.publicId;
  const userId = submission.userId.toString();
  const adminUser = await User.findOne({ userId }).select('name org').lean();
  await KycSubmission.updateOne(
    { kycId },
    {
      $set: {
        userId,
        person: person || submission.declaredDetails.fullName || adminUser?.name || userId,
        org: adminUser?.org ?? '',
        tier: submission.requestedTier ?? 1,
        status: 'in_review',
        submittedAt: submission.submittedAt ?? new Date(),
      },
      $setOnInsert: { history: [{ action: 'Submitted from customer app', at: new Date() }] },
    },
    { upsert: true },
  );
  await writeAdminKycDocuments(submission, []);
  const projected = await KycDocument.countDocuments({ kycId });
  if (projected === 0) {
    await KycDocument.updateOne(
      { docId: `${kycId}:identity` },
      {
        $set: {
          kycId,
          userId,
          type: 'identity',
          name: 'Identity document',
          status: 'in_review',
          tier: submission.requestedTier ?? 1,
        },
      },
      { upsert: true },
    );
  }
  await User.updateOne({ userId }, { $set: { kycStatus: 'pending', status: 'in_review', name: person || submission.declaredDetails.fullName || adminUser?.name || userId } });
}

/** Applies a console KYC decision to the customer submission when one exists. */
export async function applyAdminKycToCustomer(input: {
  kycId: string;
  staffId: string;
  decision: 'approve' | 'reject' | 'request_resubmission';
  reason?: string;
  /** Admin document ids (`KYC-…:id_front`). Empty means every capture on a resubmission. */
  documentIds?: string[];
}): Promise<void> {
  const decision =
    input.decision === 'approve'
      ? { type: 'approve' as const }
      : input.decision === 'reject'
        ? { type: 'reject' as const, rejection: { code: 'kyc/rejected', reason: input.reason ?? 'Rejected' } }
        : {
            type: 'request_resubmission' as const,
            rejection: { code: 'kyc/resubmission', reason: input.reason ?? 'Please resubmit' },
          };
  try {
    const decided = await decideSubmission({ submission: input.kycId, staffPublicId: input.staffId, decision });
    await stampCustomerDocumentReview(decided.id, input);
  } catch (err) {
    if (err instanceof AppError && err.code === 'resource/not-found') return;
    throw err;
  }
}

async function stampCustomerDocumentReview(
  submissionId: string,
  input: { decision: 'approve' | 'reject' | 'request_resubmission'; reason?: string; documentIds?: string[] },
): Promise<void> {
  if (!isValidObjectId(submissionId)) return;
  const now = new Date();
  const base = { submissionId: new Types.ObjectId(submissionId), discardedAt: null };
  if (input.decision === 'approve') {
    await KycDocumentModel.updateMany(base, { $set: { review: { status: 'verified', decidedAt: now } } });
    return;
  }
  const kinds = (input.documentIds ?? [])
    .map((id) => id.split(':')[1])
    .filter((kind): kind is KycDocKind => kind === 'id_front' || kind === 'id_back' || kind === 'selfie');
  const reason = input.reason || 'Please resubmit';
  if (!kinds.length) {
    await KycDocumentModel.updateMany(base, { $set: { review: { status: 'rejected', reason, decidedAt: now } } });
    return;
  }
  await KycDocumentModel.updateMany(
    { ...base, kind: { $in: kinds } },
    { $set: { review: { status: 'rejected', reason, decidedAt: now } } },
  );
  await KycDocumentModel.updateMany(
    { ...base, kind: { $nin: kinds } },
    { $set: { review: { status: 'verified', decidedAt: now } } },
  );
}

function quantityFromGrams(grams: number): { value: number; unit: 'g' | 'kg' | 't' } {
  if (grams >= 1_000_000) return { value: Math.round((grams / 1_000_000) * 1000) / 1000, unit: 't' };
  if (grams >= 1000) return { value: Math.round((grams / 1000) * 1000) / 1000, unit: 'kg' };
  return { value: grams, unit: 'g' };
}

export async function projectCustomerOrder(order: IOrder): Promise<void> {
  const line = order.lines[0];
  const qty = quantityFromGrams(order.totalGrams);
  await Order.updateOne(
    { orderId: order.reference },
    {
      $set: {
        side: order.side,
        status: order.status === 'cancelled' ? 'cancelled' : order.status === 'completed' ? 'completed' : 'active',
        mineral: { name: line?.name ?? 'Mineral' },
        counterpartyId: order.userId,
        quantity: qty,
        stage: 'verification',
        value: { amountMinor: order.total.amountMinor, currency: order.total.currency, scale: 2 },
        openedAt: order.createdAt ?? new Date(),
        origin: order.region,
        note: `Customer order ${order._id}`,
      },
      $setOnInsert: {
        stageEnteredAt: new Date(),
        stageLog: [{ stage: 'verification', at: new Date(), description: 'Received from the customer app' }],
        paymentStatus: 'due_on_approval',
      },
    },
    { upsert: true },
  );
}

const CUSTOMER_STATUS_FOR_STAGE: Record<number, IOrder['status']> = {
  0: 'pending_review',
  1: 'active',
  2: 'active',
  3: 'active',
  4: 'active',
  5: 'completed',
};

/** Desk stage change on `adm_orders` is written back onto the customer order with the same reference. */
export async function reflectAdminOrderStage(orderReference: string, stage: string): Promise<void> {
  const idx = ORDER_STAGES.indexOf(stage as OrderStage);
  if (idx < 0) return;
  const status = CUSTOMER_STATUS_FOR_STAGE[idx] ?? 'active';
  await OrderModel.updateOne(
    { reference: orderReference },
    {
      $set: { stageIndex: idx, status },
      $push: { stageHistory: { index: idx, key: stage, at: new Date(), note: 'Updated from the operations console' } },
    },
  );
}

export async function safeProject(label: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    logger.error({ err, label }, 'customer/admin projection failed');
  }
}
