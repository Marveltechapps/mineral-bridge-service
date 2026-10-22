import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { isValidObjectId, Types } from 'mongoose';
import { logger } from '../config/logger.js';
import { AppError } from '../common/errors/app-error.js';
import { loadEnv } from '../config/env.js';
import { FileModel } from '../models/file.model.js';
import { OrderModel } from '../models/order.model.js';
import type { IOrder } from '../models/order.model.js';
import { UserModel } from '../models/user.model.js';
import { ListingModel } from '../models/web-trade.model.js';
import type { IListing, ListingStatus } from '../models/web-trade.model.js';
import { unitPriceMinorPerGram } from '../common/utils/pricing-math.js';
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

const SETTLEMENT_LABEL: Record<string, string> = {
  escrow: 'Escrow',
  wire: 'Wire transfer',
  lc: 'Letter of credit',
  btc: 'Bitcoin',
};

const FORM_LABEL: Record<string, string> = {
  raw: 'Raw',
  semi_finished: 'Semi-finished',
  finished: 'Finished',
};

const LISTING_STATUS_FOR_STAGE: Record<string, ListingStatus> = {
  verification: 'submitted',
  pricing_confirmation: 'submitted',
  agent_visit: 'visit_scheduled',
  inspection_approval: 'verified',
  payment_released: 'paid',
  custody_transfer: 'received',
};

const VERIFICATION_LABEL: Record<ListingStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  visit_scheduled: 'Visit scheduled',
  verified: 'Verified',
  in_transit: 'In transit',
  received: 'Received',
  paid: 'Paid',
  rejected: 'Rejected',
};

function adminOrderStatus(status: string): 'active' | 'completed' | 'cancelled' {
  if (status === 'cancelled' || status === 'rejected') return 'cancelled';
  if (status === 'completed' || status === 'paid') return 'completed';
  return 'active';
}

function moneyFrom(doc?: { amountMinor?: number; currency?: string } | null) {
  if (!doc || typeof doc.amountMinor !== 'number') return undefined;
  return { amountMinor: doc.amountMinor, currency: doc.currency || 'USD', scale: 2 };
}

function listingLocation(address: IListing['verificationAddress']): string {
  const country = address.countryName || address.country;
  return [address.streetAddress, address.city, address.region, country].filter(Boolean).join(', ');
}

function stageForListing(status: ListingStatus): OrderStage {
  if (status === 'visit_scheduled') return 'agent_visit';
  if (status === 'verified' || status === 'in_transit') return 'inspection_approval';
  if (status === 'paid') return 'payment_released';
  if (status === 'received') return 'custody_transfer';
  return 'verification';
}

async function projectAccountForUser(userId: string): Promise<void> {
  const user = await UserModel.findById(userId).lean();
  if (!user) return;
  await projectCustomerAccount({
    id: userId,
    name: user.profile?.fullName || user.profile?.displayName || 'Customer',
    email: user.email,
    phone: user.phone,
    org: user.profile?.companyName,
    country: user.profile?.countryCode,
    tier: user.tier,
    kycStatus: user.kycStatus,
  });
}

export async function projectCustomerOrder(order: IOrder): Promise<void> {
  const line = order.lines[0];
  const qty = quantityFromGrams(order.totalGrams);
  const stage = ORDER_STAGES[order.stageIndex] ?? 'verification';
  const rateMinor = line?.unitPriceMinorE4PerGram ? unitPriceMinorPerGram(line.unitPriceMinorE4PerGram) : undefined;
  const settlement = SETTLEMENT_LABEL[order.settlement?.method || order.paymentMethod] ?? order.paymentMethod;
  const commercial: Record<string, unknown> = {
    side: order.side,
    mineral: { ...(line?.productId ? { id: line.productId } : {}), name: line?.name ?? 'Mineral' },
    counterpartyId: order.userId,
    quantity: qty,
    value: { amountMinor: order.total.amountMinor, currency: order.total.currency || 'USD', scale: 2 },
    openedAt: order.createdAt ?? new Date(),
    origin: [order.delivery?.city, order.delivery?.region, order.region].filter(Boolean).join(', '),
    destination: order.delivery?.facilityName || order.delivery?.streetAddress || '',
    settlementMethod: settlement,
    customerStatus: order.status,
    note: `Customer order ${order._id}`,
  };
  if (rateMinor) {
    commercial.lockedRate = { amountMinor: rateMinor, currency: order.total.currency || 'USD', scale: 2, per: 'g' };
  }
  const existing = await Order.findOne({ orderId: order.reference }).select('_id').lean();
  if (existing) {
    await Order.updateOne(
      { orderId: order.reference },
      { $set: { ...commercial, status: adminOrderStatus(order.status) } },
    );
    return;
  }
  await Order.updateOne(
    { orderId: order.reference },
    {
      $set: commercial,
      $setOnInsert: {
        status: adminOrderStatus(order.status),
        stage,
        stageEnteredAt: new Date(),
        stageLog: [{ stage, at: new Date(), description: 'Received from the customer app' }],
        paymentStatus: order.settlement?.status === 'released' ? 'released' : 'due_on_approval',
      },
    },
    { upsert: true },
  );
}

async function listingPhotoDocuments(listing: IListing) {
  const documents = [];
  for (const [index, photo] of listing.photos.entries()) {
    try {
      await mirrorCustomerFileForReview({
        fileId: photo.fileId,
        userId: listing.userId,
        kycId: listing.reference,
        name: `Listing photo ${index + 1}`,
      });
    } catch (err) {
      logger.error({ err, fileId: photo.fileId }, 'listing photo was not mirrored for review');
    }
    documents.push({
      id: photo._id,
      name: `Photo ${index + 1}`,
      ref: photo.fileId,
      status: 'in_review',
      fileId: photo.fileId,
    });
  }
  return documents;
}

/** A submitted customer sell listing becomes a sell-side order the desk can verify. */
export async function projectCustomerListing(listing: IListing): Promise<void> {
  if (listing.status === 'draft') return;
  try {
    await projectAccountForUser(listing.userId);
  } catch (err) {
    logger.error({ err, userId: listing.userId }, 'seller account was not projected');
  }
  const qty = quantityFromGrams(listing.grams);
  const value = moneyFrom(listing.indicativeNet ?? listing.quoteSnapshot?.net);
  const gross = moneyFrom(listing.quoteSnapshot?.gross);
  const documents = await listingPhotoDocuments(listing);
  const stage = stageForListing(listing.status);
  const commercial: Record<string, unknown> = {
    side: 'sell',
    mineral: { ...(listing.mineralId ? { id: listing.mineralId } : {}), name: listing.mineralName },
    counterpartyId: listing.userId,
    quantity: qty,
    openedAt: listing.submittedAt ?? listing.createdAt ?? new Date(),
    origin: listingLocation(listing.verificationAddress),
    settlementMethod: listing.payoutPreference || 'Seller payout',
    mineralForm: FORM_LABEL[listing.form] ?? listing.form,
    customerStatus: listing.status,
    verificationStatus: VERIFICATION_LABEL[listing.status] ?? listing.status,
    listingId: listing._id,
    note: `Customer sell listing ${listing.reference}`,
  };
  if (value) commercial.value = value;
  if (gross && listing.grams > 0) {
    commercial.lockedRate = {
      amountMinor: Math.round(gross.amountMinor / listing.grams),
      currency: gross.currency,
      scale: 2,
      per: 'g',
    };
  }
  const existing = await Order.findOne({ orderId: listing.reference }).select('documents').lean();
  if (existing) {
    await Order.updateOne(
      { orderId: listing.reference },
      {
        $set: {
          ...commercial,
          status: adminOrderStatus(listing.status),
          ...((existing.documents ?? []).length === 0 && documents.length ? { documents } : {}),
        },
      },
    );
    return;
  }
  await Order.updateOne(
    { orderId: listing.reference },
    {
      $set: commercial,
      $setOnInsert: {
        status: adminOrderStatus(listing.status),
        stage,
        stageEnteredAt: new Date(),
        stageLog: [{ stage, at: listing.submittedAt ?? new Date(), description: 'Sell listing submitted from the customer app' }],
        paymentStatus: 'due_on_approval',
        documents,
      },
    },
    { upsert: true },
  );
}

let tradeSync: Promise<void> | null = null;
let tradeSyncedAt = 0;

/** Copies customer buy orders and submitted sell listings that the desk does not have yet. */
export function syncCustomerTradeToAdmin(): Promise<void> {
  if (Date.now() - tradeSyncedAt < 15_000) return Promise.resolve();
  if (!tradeSync) {
    tradeSync = (async () => {
      try {
        const orders = await OrderModel.find().sort({ createdAt: -1 }).limit(200).lean<IOrder[]>();
        for (const order of orders) {
          await safeProject(`order ${order.reference}`, async () => {
            await projectAccountForUser(order.userId);
            await projectCustomerOrder(order);
          });
        }
        const listings = await ListingModel.find({ status: { $ne: 'draft' } }).sort({ createdAt: -1 }).limit(200).lean<IListing[]>();
        for (const listing of listings) {
          await safeProject(`listing ${listing.reference}`, () => projectCustomerListing(listing));
        }
        tradeSyncedAt = Date.now();
      } catch (err) {
        logger.error({ err }, 'customer trade sync failed');
      }
    })().finally(() => {
      tradeSync = null;
    });
  }
  return tradeSync;
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
  await Order.updateOne({ orderId: orderReference }, { $set: { customerStatus: status } });
  const listing = await ListingModel.findOne({ reference: orderReference }).lean<IListing>();
  if (!listing) return;
  let next = LISTING_STATUS_FOR_STAGE[stage];
  if (!next) return;
  if (stage === 'custody_transfer' && listing.status === 'paid') next = 'paid';
  await ListingModel.updateOne({ reference: orderReference }, { $set: { status: next } });
  await Order.updateOne(
    { orderId: orderReference },
    { $set: { customerStatus: next, verificationStatus: VERIFICATION_LABEL[next] } },
  );
}

export async function safeProject(label: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    logger.error({ err, label }, 'customer/admin projection failed');
  }
}
