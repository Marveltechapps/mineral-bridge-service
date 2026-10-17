import { logger } from '../config/logger.js';
import { AppError } from '../common/errors/app-error.js';
import { OrderModel } from '../models/order.model.js';
import type { IOrder } from '../models/order.model.js';
import { KycDocument, KycSubmission, User } from '../models/people.models.js';
import { Order } from '../models/trading.models.js';
import { ORDER_STAGES, type OrderStage } from '../modules/admin/shared/enums.js';
import { decideSubmission } from '../modules/kyc/kyc.review.js';
import type { KycSubmissionRecord } from '../modules/kyc/kyc.types.js';

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

export async function projectKycSubmission(submission: KycSubmissionRecord, person?: string): Promise<void> {
  const kycId = submission.reference ?? submission.publicId;
  const userId = submission.userId.toString();
  await KycSubmission.updateOne(
    { kycId },
    {
      $set: {
        userId,
        person: person || submission.declaredDetails.fullName || userId,
        tier: submission.requestedTier ?? 1,
        status: 'in_review',
        submittedAt: submission.submittedAt ?? new Date(),
      },
      $setOnInsert: { history: [{ action: 'Submitted from customer app', at: new Date() }] },
    },
    { upsert: true },
  );
  await KycDocument.updateOne(
    { docId: `${kycId}-id` },
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
  await User.updateOne({ userId }, { $set: { kycStatus: 'pending', status: 'in_review' } });
}

/** Applies a console KYC decision to the customer submission when one exists. */
export async function applyAdminKycToCustomer(input: {
  kycId: string;
  staffId: string;
  decision: 'approve' | 'reject' | 'request_resubmission';
  reason?: string;
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
    await decideSubmission({ submission: input.kycId, staffPublicId: input.staffId, decision });
  } catch (err) {
    if (err instanceof AppError && err.code === 'resource/not-found') return;
    throw err;
  }
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
