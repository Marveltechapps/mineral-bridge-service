import { UserModel } from '../../../models/user.model.js';
import { OrderModel } from '../../../models/order.model.js';
import { PaymentModel, RefundModel, SellerPayoutModel } from '../../../models/workflow.model.js';
import { AuctionModel } from '../../../models/auction.model.js';
import { KycSubmissionModel } from '../../kyc/kyc.model.js';

function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers.join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n') + '\n';
}

function parseRange(q: { from?: string; to?: string }) {
  const filter: Record<string, unknown> = {};
  if (q.from || q.to) {
    filter.createdAt = {
      ...(q.from ? { $gte: new Date(q.from) } : {}),
      ...(q.to ? { $lte: new Date(q.to) } : {}),
    };
  }
  return filter;
}

export const adminExportService = {
  async customers(q: { from?: string; to?: string; search?: string }) {
    const filter: Record<string, unknown> = { ...parseRange(q) };
    if (q.search) {
      filter.$or = [
        { 'profile.fullName': new RegExp(q.search, 'i') },
        { email: new RegExp(q.search, 'i') },
        { customerNo: new RegExp(q.search, 'i') },
      ];
    }
    const rows = await UserModel.find(filter).sort({ createdAt: -1 }).limit(5000).lean();
    return toCsv(
      ['customer_no', 'name', 'email', 'phone_masked', 'kyc_status', 'account_status', 'created_at'],
      rows.map((u) => {
        const phone = (u as { phone?: string }).phone ?? '';
        const masked = phone.length > 4 ? `${phone.slice(0, 4)}****${phone.slice(-2)}` : '';
        return [
          (u as { customerNo?: string }).customerNo,
          (u as { profile?: { fullName?: string } }).profile?.fullName,
          (u as { email?: string }).email,
          masked,
          (u as { kycStatus?: string }).kycStatus,
          (u as { accountStatus?: string }).accountStatus,
          (u as { createdAt?: Date }).createdAt?.toISOString?.(),
        ];
      }),
    );
  },

  async orders(q: { from?: string; to?: string; kind?: string; q?: string }) {
    const filter: Record<string, unknown> = { ...parseRange(q) };
    if (q.kind) filter.side = q.kind;
    if (q.q) filter.$or = [{ reference: new RegExp(q.q, 'i') }, { customerNo: new RegExp(q.q, 'i') }];
    const rows = await OrderModel.find(filter).sort({ createdAt: -1 }).limit(5000).lean();
    return toCsv(
      ['ref', 'kind', 'customer_no', 'customer', 'items', 'step', 'hold', 'value_minor', 'currency', 'created_at'],
      rows.map((o) => [
        o.reference,
        o.side,
        o.customerNo,
        o.userId,
        o.lines?.length ?? 0,
        o.workflow?.stepKey,
        o.hold?.type,
        (o.pricing?.lockedTotal ?? o.total)?.amountMinor,
        (o.pricing?.lockedTotal ?? o.total)?.currency,
        o.createdAt?.toISOString?.(),
      ]),
    );
  },

  async payments(q: { from?: string; to?: string }) {
    const rows = await PaymentModel.find(parseRange(q)).sort({ createdAt: -1 }).limit(5000).lean();
    return toCsv(
      ['id', 'order_id', 'user_id', 'method', 'status', 'amount_minor', 'currency', 'created_at'],
      rows.map((p) => [
        p._id,
        p.orderId,
        p.userId,
        p.method,
        p.status,
        p.amount?.amountMinor,
        p.amount?.currency,
        p.createdAt?.toISOString?.(),
      ]),
    );
  },

  async refunds(q: { from?: string; to?: string; status?: string }) {
    const filter: Record<string, unknown> = { ...parseRange(q) };
    if (q.status) filter.status = q.status;
    const rows = await RefundModel.find(filter).sort({ createdAt: -1 }).limit(5000).lean();
    return toCsv(
      ['ref', 'order_id', 'user_id', 'type', 'status', 'amount_minor', 'currency', 'due_by', 'created_at'],
      rows.map((r) => [
        r.reference,
        r.orderId,
        r.userId,
        r.type,
        r.status,
        r.amount?.amountMinor,
        r.amount?.currency,
        r.dueBy?.toISOString?.(),
        r.createdAt?.toISOString?.(),
      ]),
    );
  },

  async auctions(q: { from?: string; to?: string; status?: string }) {
    const filter: Record<string, unknown> = { ...parseRange(q) };
    if (q.status) filter.status = q.status;
    const rows = await AuctionModel.find(filter).sort({ createdAt: -1 }).limit(5000).lean();
    return toCsv(
      ['ref', 'name', 'status', 'bid_count', 'highest_minor', 'currency', 'opens_at', 'closes_at', 'outcome'],
      rows.map((a) => [
        a.reference,
        a.name,
        a.status,
        a.bidCount,
        a.highest?.amountMinor,
        a.currency,
        a.opensAt?.toISOString?.(),
        a.closesAt?.toISOString?.(),
        a.outcome?.result,
      ]),
    );
  },

  async kyc(q: { from?: string; to?: string; status?: string }) {
    const filter: Record<string, unknown> = { ...parseRange(q) };
    if (q.status) filter.status = q.status;
    const rows = await KycSubmissionModel.find(filter).sort({ createdAt: -1 }).limit(5000).lean();
    return toCsv(
      ['id', 'user_id', 'status', 'submitted_at', 'created_at'],
      rows.map((k) => {
        const row = k as unknown as {
          _id: unknown;
          userId?: unknown;
          status?: string;
          submittedAt?: Date;
          createdAt?: Date;
        };
        return [
          String(row._id),
          row.userId != null ? String(row.userId) : '',
          row.status,
          row.submittedAt?.toISOString?.(),
          row.createdAt?.toISOString?.(),
        ];
      }),
    );
  },

  async payouts(q: { from?: string; to?: string; status?: string }) {
    const filter: Record<string, unknown> = { ...parseRange(q) };
    if (q.status) filter.status = q.status;
    const rows = await SellerPayoutModel.find(filter).sort({ createdAt: -1 }).limit(5000).lean();
    return toCsv(
      ['id', 'order_id', 'user_id', 'status', 'amount_minor', 'currency', 'released_ref', 'created_at'],
      rows.map((p) => [
        p._id,
        p.orderId,
        p.userId,
        p.status,
        p.amount?.amountMinor,
        p.amount?.currency,
        p.releasedRef,
        p.createdAt?.toISOString?.(),
      ]),
    );
  },
};
