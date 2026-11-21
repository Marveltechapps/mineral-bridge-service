import { OrderModel } from '../../../models/order.model.js';
import { PaymentModel, RefundModel, SellerPayoutModel } from '../../../models/workflow.model.js';
import { KycSubmissionModel } from '../../kyc/kyc.model.js';
import { SupportTicketModel } from '../../../models/support.model.js';
import { AuctionModel } from '../../../models/auction.model.js';
import { UserModel } from '../../../models/user.model.js';
import { stepDef, type WorkflowDefinitionId } from '../../workflow/workflow.definitions.js';

export async function adminOverview() {
  const [
    needsPlatform,
    waitingOnCustomers,
    paymentsToConfirm,
    kycPending,
    openRefunds,
    openSupport,
    queue,
    waitingList,
    liveAuctionCount,
    liveBidCount,
    payoutAgg,
    refundAmt,
    customersNeedingAttention,
    pendingPayouts,
    pendingChanges,
  ] = await Promise.all([
    OrderModel.countDocuments({
      'workflow.owner': { $ne: 'customer' },
      status: { $nin: ['completed', 'cancelled', 'rejected'] },
    }),
    OrderModel.countDocuments({
      'workflow.owner': 'customer',
      status: { $nin: ['completed', 'cancelled', 'rejected'] },
    }),
    PaymentModel.countDocuments({ status: { $in: ['submitted', 'confirming'] } }),
    KycSubmissionModel.countDocuments({ status: { $in: ['pending', 'in_review'] } }),
    RefundModel.countDocuments({ status: { $in: ['requested', 'review', 'approved', 'processing'] } }),
    SupportTicketModel.countDocuments({ status: { $nin: ['resolved', 'closed'] } }),
    OrderModel.find({
      'workflow.owner': { $ne: 'customer' },
      status: { $nin: ['completed', 'cancelled', 'rejected'] },
    })
      .sort({ 'workflow.enteredAt': 1 })
      .limit(20)
      .lean(),
    OrderModel.find({
      'workflow.owner': 'customer',
      status: { $nin: ['completed', 'cancelled', 'rejected'] },
    })
      .sort({ 'workflow.enteredAt': 1 })
      .limit(20)
      .lean(),
    AuctionModel.countDocuments({ status: 'live' }),
    AuctionModel.aggregate([{ $match: { status: 'live' } }, { $group: { _id: null, bids: { $sum: '$bidCount' } } }]),
    SellerPayoutModel.aggregate([
      { $match: { status: { $in: ['pending_approval', 'approved'] } } },
      { $group: { _id: '$amount.currency', amountMinor: { $sum: '$amount.amountMinor' } } },
    ]),
    RefundModel.aggregate([
      { $match: { status: { $in: ['requested', 'review', 'approved', 'processing'] } } },
      { $group: { _id: '$amount.currency', amountMinor: { $sum: '$amount.amountMinor' } } },
    ]),
    UserModel.countDocuments({
      $or: [{ kycStatus: { $in: ['pending', 'in_review'] } }, { accountStatus: 'suspended' }],
    }),
    SellerPayoutModel.countDocuments({ status: { $in: ['pending_approval', 'approved'] } }),
    OrderModel.countDocuments({ 'hold.type': 'changes' }),
  ]);

  const over24h = queue.filter(
    (o) => o.workflow?.enteredAt && Date.now() - new Date(o.workflow.enteredAt).getTime() > 86_400_000,
  ).length;

  const liveAuctions = await AuctionModel.find({ status: 'live' }).sort({ closesAt: 1 }).limit(10).lean();

  return {
    kpis: {
      needsPlatform: { count: needsPlatform, over24h },
      waitingOnCustomers,
      paymentsToConfirm,
      payoutsToRelease: {
        amountMinor: payoutAgg[0]?.amountMinor ?? 0,
        currency: payoutAgg[0]?._id ?? 'USD',
        scale: 2,
      },
      liveAuctions: { count: liveAuctionCount, bids: liveBidCount[0]?.bids ?? 0 },
      kycToReview: { pending: kycPending, awaitingReupload: 0 },
      openRefunds: {
        count: openRefunds,
        amount: { amountMinor: refundAmt[0]?.amountMinor ?? 0, currency: refundAmt[0]?._id ?? 'USD' },
      },
      completedValue: { amountMinor: 0, currency: 'USD' },
    },
    queue: queue.map((o) => ({
      ref: o.reference,
      kind: o.side,
      customer: o.customerNo ?? o.userId,
      country: o.delivery?.country ?? null,
      waitingFor: o.workflow
        ? stepDef(o.workflow.definition as WorkflowDefinitionId, o.workflow.stepKey).label
        : null,
      role: o.workflow?.role ?? o.workflow?.owner,
      enteredAt: o.workflow?.enteredAt?.toISOString?.() ?? o.updatedAt.toISOString(),
      value: o.pricing?.lockedTotal ?? o.total,
      overdue: o.workflow?.enteredAt
        ? Date.now() - new Date(o.workflow.enteredAt).getTime() > 86_400_000
        : false,
    })),
    waitingOnCustomers: waitingList.map((o) => ({
      ref: o.reference,
      label: o.workflow
        ? stepDef(o.workflow.definition as WorkflowDefinitionId, o.workflow.stepKey).label
        : o.status,
      enteredAt: o.workflow?.enteredAt?.toISOString?.() ?? o.updatedAt.toISOString(),
    })),
    liveAuctions: liveAuctions.map((a) => ({
      ref: a.reference,
      name: a.name,
      bidCount: a.bidCount,
      closesAt: a.closesAt?.toISOString?.(),
      highestMinor: a.highest?.amountMinor ?? null,
    })),
    badges: {
      buy: await OrderModel.countDocuments({ side: 'buy', status: { $nin: ['completed', 'cancelled'] } }),
      sell: await OrderModel.countDocuments({ side: 'sell', status: { $nin: ['completed', 'cancelled'] } }),
      customers: customersNeedingAttention,
      refunds: openRefunds,
      support: openSupport,
      notifications: openSupport + openRefunds + kycPending,
      pendingKyc: kycPending,
      pendingPayments: paymentsToConfirm,
      pendingPayouts,
      activeAuctions: liveAuctionCount,
      pendingChangeRequests: pendingChanges,
    },
  };
}
