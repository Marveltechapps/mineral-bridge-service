/**
 * Builds the record set the admin console already renders.
 * Every value comes from MongoDB. Empty collections stay empty — nothing here is sample data.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { conflict, notFound, unprocessable } from '../../../common/errors/app-error.js';
import { recordAudit } from '../../audit/audit.service.js';
import { v2DocumentsService } from '../../documents/v2.documents.service.js';
import { getDefaultRole, noPermissions } from '../../staff/default-roles.js';
import { createStaff } from '../../staff/staff.service.js';
import { adminRow, consoleRoleSnapshot, resolveRole, ROLE_ID_BY_KEY } from './admin-access.service.js';
import { consoleCategories } from './admin-catalogue.service.js';
import { consoleStockMoves, documentsView, mediaView } from './admin-lots.service.js';
import { references } from '../../../common/utils/references.js';
import { gramsInUnit } from '../../../common/utils/quantity.js';
import { quotedPriceToE4PerGram } from '../../../common/utils/pricing-math.js';
import { AuctionModel, BidModel } from '../../../models/auction.model.js';
import { MineralTypeModel, ProductModel } from '../../../models/catalog.model.js';
import { Partner } from '../../../models/content.models.js';
import { ShipmentModel } from '../../../models/contract-lc.model.js';
import { OrderModel, type IOrder } from '../../../models/order.model.js';
import { SettingsDoc } from '../../../models/platform.models.js';
import { SupportTicketModel } from '../../../models/support.model.js';
import { NotificationModel } from '../../../models/notification.model.js';
import { sellQuoteCondition } from './sell-approval.js';
import {
  InspectionModel,
  IssuedDocumentModel,
  PaymentModel,
  QuotationModel,
  RefundModel,
  SellerPayoutModel,
} from '../../../models/workflow.model.js';
import { AuditLog } from '../../audit/audit.model.js';
import { KycDocumentModel, KycSubmissionModel } from '../../kyc/kyc.model.js';
import { reviewDocumentName } from '../../kyc/kyc.id-types.js';
import type { KycDocKind } from '../../kyc/kyc.types.js';
import { FileModel } from '../../../models/file.model.js';
import { absoluteStoragePath } from '../../storage/storage.service.js';
import { StaffModel } from '../../staff/staff.model.js';
import { UserModel } from '../../users/user.model.js';
import { userRepository } from '../../users/user.repository.js';

const JOIN_LIMIT = 2000;
/** Orders the console lists. A deleted order stays in the database with `deletedAt` set. */
export const LIVE_ORDERS = { deletedAt: { $exists: false } };
/** Admins the console lists. A deleted admin stays in the database with `deletedAt` set. */
const LIVE_STAFF = { deletedAt: { $exists: false } };

const BUY_KEYS = ['placed', 'accepted', 'quote', 'quoteOk', 'confirmed', 'contract', 'contractMb', 'paid', 'payOk', 'assigned', 'picked', 'transit', 'delivered', 'receipt', 'done'];
const SELL_KEYS = ['submitted', 'reviewed', 'quote', 'quoteOk', 'confirmed', 'contract', 'contractMb', 'form', 'formOk', 'schedule', 'inspect', 'sgs', 'reportOk', 'approved', 'payout', 'picked', 'transit', 'received', 'done'];

export const CONSOLE_SETTINGS_DEFAULTS = {
  signinEmail: true, signinWhatsapp: true, codeDigits: 4, codeResend: 30, codeExpiry: 5,
  fee: 1.2, transport: 4200, buyValidity: 7, sellValidity: 48, payoutHours: 24, minPhotos: 3,
  bidStep: 500, auctionWindow: 72, refundSla: 2, refundApprover: 50000, refundDays: '3–7', payoutApprover: 250000,
  tolerance: 0.05, btcLock: 15, btcConfs: 3, btcCountries: '',
  mUPI: true, mNet: true, mBank: true, mBTC: true,
  bankName: '', bankBank: '', bankAcct: '', bankSwift: '', bankUpi: '',
};

type Money = { amountMinor?: number; scale?: number; currency?: string } | null | undefined;

export function moneyMajor(m: Money): number {
  if (!m || typeof m.amountMinor !== 'number') return 0;
  const scale = typeof m.scale === 'number' ? m.scale : 2;
  return m.amountMinor / 10 ** scale;
}

export function consoleStage(side: string, stepKey: string | undefined, status: string | undefined): { stage: number; serverStep: string } {
  const keys = side === 'sell' ? SELL_KEYS : BUY_KEYS;
  if (status === 'completed') return { stage: keys.length, serverStep: 'done' };
  const mapped = stepKey === 'ship' ? 'picked' : stepKey === 'delivered' && side === 'sell' ? 'received' : stepKey;
  const idx = mapped ? keys.indexOf(mapped) : 0;
  return { stage: idx < 0 ? 0 : idx, serverStep: stepKey || keys[Math.max(idx, 0)] || keys[0]! };
}

const CONSOLE_KYC_KIND: Record<string, string> = {
  id_front: 'idFront',
  id_back: 'idBack',
  selfie: 'selfie',
  proof_of_address: 'address',
  business_registration: 'business',
};

/** Console drawers key images by `idFront` / `address` / `business`. A passport photo page is the front capture. */
export function consoleKycKind(kind: string, idTypeId?: string | null): string {
  if (kind === 'id_front' && idTypeId === 'passport') return 'passport';
  return CONSOLE_KYC_KIND[kind] || kind;
}

/** Relative admin URL. The dashboard proxies `/v2/admin`, and the session cookie is scoped to that path. */
export function kycFileViewUrl(fileId: string): string {
  return `/v2/admin/files/${encodeURIComponent(fileId)}/content`;
}

function fileOnDisk(storageKey: string | undefined): boolean {
  if (!storageKey) return false;
  try {
    return existsSync(absoluteStoragePath(storageKey));
  } catch {
    return false;
  }
}

export function kycWord(status: string | undefined): string {
  if (status === 'verified' || status === 'approved') return 'approved';
  if (status === 'resubmission_required' || status === 'requested') return 'requested';
  if (status === 'rejected') return 'rejected';
  if (status === 'pending' || status === 'in_review' || status === 'submitted') return 'pending';
  return 'pending';
}

export function customerRole(roles: string[] | undefined): 'buyer' | 'seller' | 'both' {
  const buyer = roles?.includes('buyer') || roles?.includes('both');
  const seller = roles?.includes('seller') || roles?.includes('both');
  if (buyer && seller) return 'both';
  if (seller) return 'seller';
  if (buyer) return 'buyer';
  return 'both';
}

const PAY_METHOD: Record<string, string> = {
  bank_transfer: 'Bank transfer',
  wire: 'Bank transfer',
  upi: 'UPI',
  net_banking: 'Net banking',
  btc: 'Bitcoin',
  escrow: 'Bank transfer',
  lc: 'Other',
  other: 'Other',
};

const DOC_TYPE: Record<string, string> = {
  quotation: 'Price quotation',
  e_contract: 'E-contract',
  sell_e_contract: 'Sell e-contract',
  auction_terms: 'Auction terms',
  auction_certificate: 'Auction result certificate',
  payment_receipt: 'Payment receipt',
  tax_invoice: 'Tax invoice',
  inspection_report: 'Third-party inspection report',
  test_certificate: 'Test certificate',
  payment_advice: 'Payment advice',
  consignment_note: 'Consignment note',
  proof_of_delivery: 'Proof of delivery',
  completion_certificate: 'Completion certificate',
  refund_receipt: 'Refund receipt',
};

function consolePartnerType(type: string | undefined) {
  if (type === 'lab' || type === 'lab_assay' || type === 'inspection_agency' || type === 'inspection') return 'inspection';
  if (type === 'logistics' || type === 'bonded_carrier') return 'logistics';
  return type || '';
}

function partnerName(names: Map<string, string>, id: string | undefined | null, empty: string) {
  const raw = String(id || '').trim();
  if (!raw) return empty;
  return names.get(raw) || raw;
}

function recordedQty(q?: { value?: number; base?: number } | null): number | undefined {
  if (!q) return undefined;
  if (q.value != null && Number.isFinite(Number(q.value))) return Number(q.value);
  if (q.base != null && Number.isFinite(Number(q.base))) return Number(q.base);
  return undefined;
}

function inspectorLabel(names: Map<string, string>, id: string | undefined, written?: string) {
  const raw = String(id || '').trim();
  const named = raw ? names.get(raw) || '' : '';
  if (named) return named;
  if (raw && !/^(PT-|ins_|usr_)/i.test(raw) && !/^[a-f0-9]{24}$/i.test(raw)) return raw;
  return String(written || '').trim();
}

function ms(value: Date | string | undefined | null): number {
  if (!value) return Date.now();
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : Date.now();
}

function gramsToQty(grams: number, unit: string): number {
  if (unit === 'kg') return grams / 1000;
  if (unit === 't') return grams / 1_000_000;
  return grams;
}

export async function buildAdminConsole(input?: { page?: number; pageSize?: number }) {
  const page = Math.max(1, Math.floor(input?.page ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.floor(input?.pageSize ?? 50) || 50));
  const skip = (page - 1) * pageSize;
  const [
    orders,
    users,
    products,
    auctions,
    bids,
    payments,
    payouts,
    refunds,
    documents,
    tickets,
    notifications,
    kycRows,
    kycDocs,
    audits,
    partners,
    shipments,
    inspections,
    staff,
    settingsDoc,
    templateDoc,
    orderTotal,
    userTotal,
    productTotal,
    auctionTotal,
    paymentTotal,
    refundTotal,
    documentTotal,
    ticketTotal,
    notificationTotal,
    kycTotal,
    auditTotal,
    partnerTotal,
    shipmentTotal,
    inspectionTotal,
    staffTotal,
    cats,
    roleSnapshot,
    stockMoves,
  ] = await Promise.all([
    OrderModel.find(LIVE_ORDERS).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean<IOrder[]>(),
    UserModel.find({ isDeleted: { $ne: true } }).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
    ProductModel.find({}).sort({ updatedAt: -1 }).skip(skip).limit(pageSize).lean(),
    AuctionModel.find({}).sort({ closesAt: -1 }).skip(skip).limit(pageSize).lean(),
    BidModel.find({}).sort({ placedAt: 1 }).limit(JOIN_LIMIT).lean(),
    PaymentModel.find({}).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
    SellerPayoutModel.find({}).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
    RefundModel.find({}).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
    IssuedDocumentModel.find({}).sort({ issuedAt: -1 }).skip(skip).limit(pageSize).lean(),
    SupportTicketModel.find({}).sort({ updatedAt: -1 }).skip(skip).limit(pageSize).lean(),
    NotificationModel.find({}).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
    KycSubmissionModel.find({ status: { $ne: 'draft' } }).sort({ submittedAt: -1 }).skip(skip).limit(pageSize).lean(),
    KycDocumentModel.find({}).limit(JOIN_LIMIT).lean(),
    AuditLog.find({}).sort({ at: -1 }).skip(skip).limit(pageSize).lean(),
    Partner.find({}).sort({ name: 1 }).skip(skip).limit(pageSize).lean(),
    ShipmentModel.find({}).sort({ updatedAt: -1 }).skip(skip).limit(pageSize).lean(),
    InspectionModel.find({}).sort({ updatedAt: -1 }).skip(skip).limit(pageSize).lean(),
    StaffModel.find(LIVE_STAFF).sort({ name: 1 }).skip(skip).limit(pageSize).select('publicId name email role roleKey disabled mfa').lean(),
    SettingsDoc.findOne({ key: 'platform' }).lean(),
    SettingsDoc.findOne({ key: 'document_templates' }).lean(),
    OrderModel.countDocuments(LIVE_ORDERS),
    UserModel.countDocuments({ isDeleted: { $ne: true } }),
    ProductModel.countDocuments({}),
    AuctionModel.countDocuments({}),
    PaymentModel.countDocuments({}),
    RefundModel.countDocuments({}),
    IssuedDocumentModel.countDocuments({}),
    SupportTicketModel.countDocuments({}),
    NotificationModel.countDocuments({}),
    KycSubmissionModel.countDocuments({ status: { $ne: 'draft' } }),
    AuditLog.countDocuments({}),
    Partner.countDocuments({}),
    ShipmentModel.countDocuments({}),
    InspectionModel.countDocuments({}),
    StaffModel.countDocuments(LIVE_STAFF),
    consoleCategories(),
    consoleRoleSnapshot(),
    consoleStockMoves(),
  ]);

  const productById = new Map(products.map((p) => [String(p._id), p]));
  const productByRef = new Map(products.map((p) => [p.reference, p]));
  // Auctions and orders are paged separately from products. A live auction on this page can
  // point at a lot that is not in this page's product slice; resolve those lots before mapping.
  const wantedProductIds = new Set<string>();
  const noteProduct = (id?: string) => { if (id) wantedProductIds.add(String(id)); };
  for (const auction of auctions) noteProduct(auction.productId);
  for (const order of orders) for (const line of order.lines ?? []) noteProduct(line.productId);
  const missingProductIds = [...wantedProductIds].filter((id) => !productById.has(id) && !productByRef.has(id));
  if (missingProductIds.length) {
    const extraProducts = await ProductModel.find({
      $or: [{ _id: { $in: missingProductIds } }, { reference: { $in: missingProductIds } }],
    }).lean();
    for (const product of extraProducts) {
      productById.set(String(product._id), product);
      if (product.reference) productByRef.set(product.reference, product);
    }
  }
  const orderById = new Map(orders.map((o) => [String(o._id), o]));
  const payByOrder = new Map<string, (typeof payments)[number]>();
  for (const p of payments) if (!payByOrder.has(String(p.orderId))) payByOrder.set(String(p.orderId), p);
  const payoutByOrder = new Map(payouts.map((p) => [String(p.orderId), p]));
  const shipByOrder = new Map(shipments.map((s) => [String(s.orderId), s]));
  const inspByOrder = new Map(inspections.map((s) => [String(s.orderId), s]));
  const orderIds = orders.map((o) => String(o._id));
  if (orderIds.length) {
    const linked = await ShipmentModel.find({ orderId: { $in: orderIds } }).sort({ updatedAt: 1 }).lean();
    for (const shipment of linked) shipByOrder.set(String(shipment.orderId), shipment);
  }
  const quotations = orderIds.length
    ? await QuotationModel.find({ orderId: { $in: orderIds } }).sort({ rev: 1 }).lean()
    : [];
  const quotesByOrder = new Map<string, typeof quotations>();
  for (const q of quotations) {
    const key = String(q.orderId);
    const list = quotesByOrder.get(key) || [];
    list.push(q);
    quotesByOrder.set(key, list);
  }

  const customers = users.map((u) => {
    const profile = (u as { profile?: { fullName?: string; companyName?: string; countryCode?: string } }).profile;
    const business = (u as { business?: { name?: string; buyerType?: string; sellerType?: string } }).business;
    const roles = (u as { roles?: string[] }).roles;
    const signin = (u as { signInMethod?: string }).signInMethod === 'email' ? 'email' : 'whatsapp';
    return {
      id: (u as { customerNo?: string }).customerNo || String(u._id),
      userId: String(u._id),
      name: profile?.fullName || (u as { email?: string }).email || 'Customer',
      business: business?.name || profile?.companyName || '',
      email: (u as { email?: string }).email || '',
      whatsapp: (u as { whatsapp?: string }).whatsapp || (u as { phone?: string }).phone || '',
      country: profile?.countryCode || '',
      role: customerRole(roles),
      buyerType: business?.buyerType || '',
      sellerType: business?.sellerType || '',
      signin,
      kyc: kycWord((u as { kycStatus?: string }).kycStatus),
      status: (u as { accountStatus?: string }).accountStatus === 'suspended' ? 'suspended' : 'active',
      joined: ms((u as { createdAt?: Date }).createdAt),
      prefs: { email: true, sms: false, whatsapp: true, push: true },
      suspendReason: (u as { suspension?: { reason?: string } }).suspension?.reason || '',
      kycRef: (u as { kycReference?: string }).kycReference || '',
    };
  });
  const custByUser = new Map(customers.map((c) => [c.userId, c]));

  const lots = products.map((p) => {
    const unit = p.qty?.unit || (p.availableGrams >= 1000 ? 'kg' : 'g');
    const avail = gramsToQty(p.availableGrams, unit);
    const status = p.status === 'active' ? 'listed' : p.status === 'sold' ? 'sold out' : p.status === 'withdrawn' ? 'archived' : 'draft';
    return {
      id: p.reference,
      productId: String(p._id),
      mineral: p.typeSlug || p.mineralCode,
      name: p.name,
      form: p.form || '',
      avail,
      unit,
      min: gramsToQty(p.minOrderGrams || 0, unit),
      grade: p.grade || p.purity || '',
      lab: p.lab?.name || '',
      cert: p.lab?.certificateNo || '',
      origin: p.origin?.display || [p.origin?.site, p.origin?.region, p.origin?.country].filter(Boolean).join(' · '),
      ref: Math.round(((p.unitPriceMinorE4PerGram || 0) * (gramsInUnit(unit) || 1)) / 1_000_000 * 100) / 100,
      status,
      images: mediaView(p).length,
      docs: (p.documents ?? []).map((d) => d.name),
      media: mediaView(p),
      ldocs: documentsView(p).map((d) => ({ ...d, file: null })),
      reserved: p.attributes?.onHold ? avail : 0,
      onHold: Boolean(p.attributes?.onHold),
      holdReason: typeof p.attributes?.holdReason === 'string' ? p.attributes.holdReason : '',
      live: true,
      version: p.version ?? 0,
    };
  });

  const partnerNameById = new Map(partners.map((p) => [p.partnerId, p.name]));
  const missingPartnerIds = [...shipByOrder.values()].map((s) => s.partnerId).filter((id): id is string => Boolean(id) && !partnerNameById.has(id));
  if (missingPartnerIds.length) {
    const named = await Partner.find({ partnerId: { $in: missingPartnerIds } }).select('partnerId name').lean();
    for (const partner of named) partnerNameById.set(partner.partnerId, partner.name);
  }
  const quoteRepairs: { id: string; conditions: string }[] = [];
  const ordersOut = orders.map((o) => {
    const cu = custByUser.get(o.userId);
    const historyKey = [...(o.stageHistory ?? [])].reverse().find((s) => s.key)?.key;
    const staged = consoleStage(o.side, o.workflow?.stepKey || historyKey, o.status);
    const pay = payByOrder.get(String(o._id));
    const payout = payoutByOrder.get(String(o._id));
    const ship = shipByOrder.get(String(o._id));
    const insp = inspByOrder.get(String(o._id));
    const agencyLabel = insp ? partnerName(partnerNameById, insp.agencyPartnerId, '') : '';
    const total = moneyMajor(o.pricing?.lockedTotal ?? o.pricing?.quotedTotal ?? o.total);
    const items = (o.lines ?? []).map((line) => {
      const product = line.productId ? productById.get(String(line.productId)) || productByRef.get(line.productId) : undefined;
      const unit = line.qty?.unit || (line.grams >= 1000 ? 'kg' : 'g');
      const qty = gramsToQty(line.grams, unit);
      return { lot: product?.reference || (line.productId ? String(line.productId) : (line.name || '')), qty, entered: line.enteredAs || '', unit };
    });
    const hist = (o.timeline ?? []).map((h) => ({
      at: ms(h.at),
      who: h.actor?.name || 'System',
      role: h.actor?.role || '',
      text: h.label,
      note: h.note || '',
    }));
    const row: Record<string, unknown> = {
      id: o.reference,
      orderId: String(o._id),
      kind: o.side,
      src: o.source?.kind === 'auction' ? (o.source.refId || 'auction') : 'direct',
      cust: cu?.id || o.customerNo || o.userId,
      items,
      sell: o.sell
        ? (() => {
            const unit = o.sell.qty?.unit || 'kg';
            const entered = (o.sell.qty as { value?: number } | undefined)?.value;
            const qty =
              entered != null && Number.isFinite(Number(entered))
                ? Number(entered)
                : gramsToQty(o.totalGrams ?? 0, unit);
            const photoIds = o.sell.photoFileIds ?? [];
            return {
              mineral: o.sell.mineralSlug,
              name: o.sell.name,
              // BUG-012/013: never surface raw gram `base` as the human quantity.
              qty,
              unit,
              form: o.sell.form || '',
              grade: o.sell.grade || '',
              photos: Math.max(photoIds.length, o.sell.photosReceived ?? 0),
              // BUG-011: expose file ids so the console can resolve preview URLs.
              photoFileIds: photoIds,
              files: photoIds.map((id, i) => ({
                kind: 'photo',
                name: `sell-photo-${i + 1}.jpg`,
                label: ['Material close-up', 'Full lot', 'Weighing scale reading', 'Bar stamp / markings', 'Storage location', 'Packaging'][i % 6],
                fileId: id,
                url: `/v2/admin/files/${encodeURIComponent(id)}/content`,
              })),
              docs: o.sell.documentFileIds ?? [],
              details: o.sell.details || '',
            };
          })()
        : undefined,
      stage: staged.stage,
      serverStep: staged.serverStep,
      version: o.version ?? 0,
      live: true,
      at: ms(o.createdAt),
      sAt: ms(o.workflow?.enteredAt ?? o.updatedAt),
      hold: o.hold?.type ? { t: o.hold.type, note: o.hold.reason || '', at: ms(o.hold.openedAt) } : null,
      rejected: o.status === 'rejected' ? (o.rejection?.reason || 'Rejected') : '',
      quotes: (quotesByOrder.get(String(o._id)) || []).map((q) => ({
        no: q.number,
        rev: q.rev,
        lines: (q.lines || []).map((l) => {
          const qty = Number(l.qty?.base ?? 0) || 1;
          return {
            name: l.name,
            qty,
            unit: l.qty?.unit || 'kg',
            price: moneyMajor(l.price),
            unitPrice: Math.round(moneyMajor(l.price) / qty),
          };
        }),
        prod: moneyMajor(q.product),
        fee: moneyMajor(q.fee),
        transport: moneyMajor(q.transport),
        other: q.other ? moneyMajor(q.other.amount) : 0,
        otherLabel: q.other?.label || '',
        deduct: q.deduction ? moneyMajor(q.deduction.amount) : 0,
        deductLabel: q.deduction?.label || '',
        total: moneyMajor(q.total),
        rate: q.rateNote || '',
        market: q.rateNote || '',
        cond: o.side === 'sell' ? (() => {
          const next = sellQuoteCondition(q.conditions, agencyLabel);
          if (q.conditions && next !== q.conditions) quoteRepairs.push({ id: String(q._id), conditions: next });
          return next;
        })() : (q.conditions || ''),
        valid: ms(q.validUntil),
        at: ms(q.issuedAt),
        status: q.status === 'accepted' ? 'accepted'
          : q.status === 'declined' ? 'declined'
          : q.status === 'replaced' ? 'replaced'
          : 'issued',
      })),
      hist,
      refunded: moneyMajor({ amountMinor: o.refundSummary?.refundedMinor, scale: 2 }),
      total,
      addr: [o.delivery?.org, o.delivery?.city, o.delivery?.country].filter(Boolean).join(', ') || cu?.country || '',
    };
    if (pay) {
      row.pay = {
        method: PAY_METHOD[pay.method] || pay.method,
        amount: moneyMajor(pay.amount),
        status: pay.status === 'confirmed' ? 'confirmed' : pay.status === 'failed' || pay.status === 'cancelled' ? 'failed' : 'pending',
        at: ms(pay.createdAt),
        ref: pay.confirmedRef || pay.gateway?.reference || '',
        attempts: pay.attempt,
        failed: pay.failure ? [{ at: ms(pay.failure.at), reason: pay.failure.reason, method: pay.method }] : [],
        proof: pay.proofFileIds?.[0] || '',
        bank: pay.payerBank || '',
        btc: pay.btc
          ? { rate: moneyMajor({ amountMinor: pay.btc.rateMinorPerBtc, scale: 2 }), amount: (pay.btc.amountSats / 1e8).toFixed(5), address: pay.btc.address, txid: pay.btc.txid || '', conf: pay.btc.confirmations ?? 0, lockAt: ms(pay.createdAt) }
          : undefined,
      };
    }
    if (payout) {
      row.payout = {
        id: String(payout._id),
        status: payout.status,
        amount: moneyMajor(payout.amount),
        method: PAY_METHOD[payout.destination?.method] || payout.destination?.method || '',
        account: payout.destination?.display || '',
        approvals: (payout.approvals ?? []).map((a) => a.staffId),
        ref: payout.releasedRef || '',
        at: payout.releasedAt ? ms(payout.releasedAt) : undefined,
      };
    }
    if (ship) {
      const events = (ship.events ?? []).map((e) => ({ t: e.title, at: ms(e.occurredAt), loc: e.location || '', note: '' }));
      row.ship = {
        id: ship.reference,
        partner: partnerName(partnerNameById, ship.partnerId, ''),
        mode: (ship.mode ?? []).join(', '),
        scope: ship.direction || ship.scope || '',
        contact: ship.contact || '',
        from: ship.pickup?.address || ship.route?.fromPort || '',
        to: ship.route?.toPort || ship.currentLocation || '',
        events,
        status: events.at(-1)?.t || ship.status,
      };
    }
    if (insp) {
      const findings = insp.findings as { weight?: { value?: number; base?: number }; seals?: string; result?: string; notes?: string; inspector?: string } | undefined;
      const report = insp.report as {
        certificateNo?: string; grade?: string; net?: { value?: number; base?: number }; result?: string;
        remarks?: string; fileId?: string; at?: Date;
        history?: Array<{ certificateNo?: string; grade?: string; result?: string; net?: { value?: number; base?: number }; at?: Date }>;
      } | undefined;
      row.insp = {
        agency: partnerName(partnerNameById, insp.agencyPartnerId, '—'),
        inspector: inspectorLabel(partnerNameById, insp.inspectorPartnerId, findings?.inspector),
        date: insp.schedule?.date || '',
        time: insp.schedule?.time || '',
        location: insp.schedule?.location || '',
        res: findings
          ? { weight: recordedQty(findings.weight) ?? 0, seals: findings.seals || '', result: findings.result || '', notes: findings.notes || '' }
          : undefined,
      };
      if (report?.certificateNo) {
        row.sgs = {
          agency: partnerName(partnerNameById, insp.agencyPartnerId, ''),
          no: report.certificateNo,
          grade: report.grade || '',
          net: recordedQty(report.net) ?? recordedQty(findings?.weight) ?? 0,
          result: report.result || '',
          remarks: report.remarks || '',
          fileId: report.fileId || '',
          at: report.at ? ms(report.at) : undefined,
          history: (report.history || []).map((item) => ({
            no: item.certificateNo || '',
            grade: item.grade || '',
            result: item.result || '',
            net: recordedQty(item.net),
            at: item.at ? ms(item.at) : undefined,
          })),
        };
      }
    }
    return row;
  });
  if (quoteRepairs.length) {
    await Promise.all(quoteRepairs.map((item) => QuotationModel.updateOne({ _id: item.id }, { $set: { conditions: item.conditions } })));
  }

  const bidsByAuction = new Map<string, { cust: string; amt: number; at: number; auto: boolean; max: number }[]>();
  for (const b of bids) {
    const list = bidsByAuction.get(String(b.auctionId)) ?? [];
    const bidder = custByUser.get(b.bidderId);
    list.push({ cust: bidder?.id || b.bidderId, amt: moneyMajor({ amountMinor: b.amountMinor, scale: 2 }), at: ms(b.placedAt), auto: b.kind === 'auto', max: 0 });
    bidsByAuction.set(String(b.auctionId), list);
  }

  const auctionsOut = auctions.map((a) => {
    const product = a.productId ? productById.get(String(a.productId)) || productByRef.get(a.productId) : undefined;
    const winner = a.outcome?.winnerId ? custByUser.get(a.outcome.winnerId) : undefined;
    const order = a.outcome?.settlementOrderId ? orderById.get(String(a.outcome.settlementOrderId)) : undefined;
    return {
      id: a.reference,
      auctionId: String(a._id),
      lot: product?.reference || (a.productId ? String(a.productId) : ''),
      name: product?.name || a.name || '',
      qty: gramsToQty(a.quantityGrams, a.qty?.unit || (a.quantityGrams >= 1000 ? 'kg' : 'g')),
      start: moneyMajor(a.startingBid),
      reserve: a.reserve ? moneyMajor(a.reserve) : 0,
      step: moneyMajor(a.minimumIncrement),
      opens: ms(a.opensAt),
      closes: ms(a.closesAt),
      reminders: 0,
      bids: bidsByAuction.get(String(a._id)) ?? [],
      paused: a.status === 'paused',
      remaining: 0,
      cancelled: a.status === 'cancelled' ? (a.cancelReason || 'Cancelled') : '',
      closed: a.status === 'ended' || a.status === 'cancelled',
      winner: winner?.id || null,
      orderId: order?.reference || null,
      nextOffered: false,
      relisted: false,
      extended: a.extensions ?? 0,
      live: true,
      version: a.version ?? 0,
      status: a.status,
    };
  });

  const refundsOut = refunds.map((r) => {
    const order = orderById.get(String(r.orderId));
    const cu = custByUser.get(r.userId);
    return {
      ref: r.reference,
      order: order?.reference || String(r.orderId),
      cust: cu?.id || r.userId,
      type: r.type,
      amount: moneyMajor(r.amount),
      reason: r.reason,
      note: r.note,
      dest: { method: r.destination?.method || 'original', bank: r.destination?.bankName || '', account: r.destination?.accountMasked || '' },
      evidence: r.attachmentFileIds ?? [],
      status: r.status,
      at: ms(r.createdAt),
      sAt: ms(r.updatedAt),
      declineReason: [...(r.decisions ?? [])].reverse().find((d) => d.action === 'decline')?.reason || '',
      bankRef: r.bankRef || '',
      approvals: (r.approvals ?? []).map((a) => a.staffId),
      method: '',
      live: true,
      version: 0,
    };
  });

  const docs = documents.map((d) => ({
    no: d.number,
    type: DOC_TYPE[d.type] || d.type,
    entity: d.entity?.type || 'order',
    eid: d.entity?.id || '',
    ver: d.version ?? 1,
    status: d.status,
    at: ms(d.issuedAt),
    by: d.issuedBy?.name || 'System',
    reason: d.cancelReason || '',
    fileId: d.fileId || '',
    live: true,
  }));

  const staffById = new Map(staff.map((s) => [String(s._id), s.name] as const).concat(staff.map((s) => [s.publicId, s.name] as const)));
  const threads = tickets.map((t) => {
    const cu = custByUser.get(t.userId);
    const order = t.orderId ? orderById.get(String(t.orderId)) : undefined;
    return {
      id: t.reference,
      cust: cu?.id || t.userId,
      ref: order?.reference || t.relatedTo?.id || null,
      tag: t.topic || 'General',
      unread: t.unreadForStaff ?? 0,
      status: t.status === 'resolved' || t.status === 'closed' ? 'resolved' : 'open',
      assignee: staffById.get(t.assignee?.staffId || '') || t.assignee?.staffId || '',
      live: true,
      version: t.version ?? 0,
      msgs: (t.messages ?? []).map((m) => ({
        from: m.author === 'user' ? 'cust' : 'admin',
        who: m.authorName || (m.author === 'user' ? cu?.name : 'Mineral Bridge'),
        text: m.body,
        at: ms(m.at),
      })),
    };
  });

  const activeKycDocs = kycDocs.filter((d) => !d.discardedAt);
  const kycFileIds = [...new Set(activeKycDocs.map((d) => d.fileId).filter((id): id is string => Boolean(id)))];
  const storedKycFiles = kycFileIds.length
    ? await FileModel.find({ _id: { $in: kycFileIds } }).lean()
    : [];
  const kycFileById = new Map(storedKycFiles.map((f) => [f._id, f]));

  const idTypeBySubmission = new Map(kycRows.map((k) => [String(k._id), k.idTypeId] as const));
  const docsBySubmission = new Map<string, Array<Record<string, string>>>();
  for (const d of activeKycDocs) {
    const key = String(d.submissionId || '');
    const list = docsBySubmission.get(key) ?? [];
    const review = d.review?.status;
    const stored = d.fileId ? kycFileById.get(d.fileId) : undefined;
    const ready = Boolean(stored && stored.bytes > 0 && !stored.deletedAt && fileOnDisk(stored.storageKey));
    const idTypeId = d.idTypeId || idTypeBySubmission.get(key);
    const kind = d.kind as KycDocKind;
    list.push({
      kind: consoleKycKind(kind, idTypeId),
      wireKind: kind,
      label: reviewDocumentName(kind, idTypeId),
      name: stored?.filename || d.originalName || '',
      status: review === 'verified' ? 'ok' : review === 'rejected' || d.flag ? 'flagged' : 'submitted',
      note: d.flag?.message || d.review?.reason || '',
      fileId: d.fileId || '',
      mimeType: ready ? (stored?.contentType || d.mimeType || '') : '',
      url: ready && d.fileId ? kycFileViewUrl(d.fileId) : '',
      availability: ready ? 'ready' : 'unavailable',
    });
    docsBySubmission.set(key, list);
  }

  const kyc = kycRows.map((k) => {
    const cu = custByUser.get(String(k.userId));
    const status = kycWord(k.status);
    return {
      ref: k.reference || k.publicId,
      submissionId: String(k._id),
      cust: cu?.id || String(k.userId),
      idType: k.idTypeId || 'Identity document',
      biz: (k.requiredKinds ?? []).includes('business_registration'),
      at: ms(k.submittedAt ?? k.createdAt),
      status,
      docs: docsBySubmission.get(String(k._id)) ?? [],
      reason: k.rejection?.reason || '',
      reviewedBy: k.decidedBy || '',
      live: true,
    };
  });

  const deliveries = notifications.flatMap((n) => {
    const cu = custByUser.get(n.userId);
    const channels = n.channels?.length ? n.channels : ['push'];
    const deliveryStatus = String((n.data as { deliveryStatus?: string } | undefined)?.deliveryStatus || 'sent');
    return channels.map((channel) => ({
      id: String(n._id),
      at: ms(n.createdAt),
      cust: cu?.id || n.userId,
      event: n.title || n.event,
      ref: (n.data as { ref?: string } | undefined)?.ref || n.target?.id || n.orderId || '',
      channel: channel === 'in_app' ? 'push' : channel,
      status: deliveryStatus === 'failed' ? 'failed' as const : deliveryStatus === 'delivered' ? 'delivered' as const : 'sent' as const,
      live: true,
    }));
  });

  const audit = audits.map((a) => ({
    at: ms(a.at),
    actor: a.actor?.name || 'System',
    role: a.actor?.role || '',
    entity: a.record?.type || a.category,
    eid: a.record?.id || '',
    action: a.action,
    before: a.beforeText || '',
    after: a.afterText || '',
    note: a.reason || '',
    ip: a.ip || '',
  }));

  const partnerRows = partners.map((p) => ({
    id: p.partnerId,
    type: consolePartnerType(p.type),
    name: p.name,
    modes: (p.modes ?? []).join(', '),
    regions: (p.regions ?? []).join(', ') || p.base || '',
    contact: [p.contactName, p.phone || p.email].filter(Boolean).join(' · '),
    active: p.status === 'active',
    live: true,
  }));

  const stored = (settingsDoc?.values ?? {}) as Record<string, unknown>;
  const settings = { ...CONSOLE_SETTINGS_DEFAULTS, ...stored };
  const templateRows = Array.isArray((templateDoc?.values as { rows?: unknown } | undefined)?.rows)
    ? ((templateDoc?.values as { rows: Array<Record<string, unknown>> }).rows)
    : [];

  return {
    v: 4,
    live: true,
    lots,
    customers,
    kyc,
    orders: ordersOut,
    auctions: auctionsOut,
    refunds: refundsOut,
    docs,
    threads,
    tpl: {},
    dtpl: templateRows.map((t) => ({ ...t, live: true })),
    deliveries,
    audit,
    settings,
    partners: partnerRows,
    admins: staff.map((s) => adminRow(s)),
    cats,
    moves: stockMoves,
    customRoles: roleSnapshot.customRoles,
    roleLabels: roleSnapshot.roleLabels,
    perms: roleSnapshot.perms,
    roles: roleSnapshot.roles,
    page,
    pageSize,
    totals: {
      orders: orderTotal,
      customers: userTotal,
      lots: productTotal,
      auctions: auctionTotal,
      payments: paymentTotal,
      refunds: refundTotal,
      docs: documentTotal,
      threads: ticketTotal,
      deliveries: notificationTotal,
      kyc: kycTotal,
      audit: auditTotal,
      partners: partnerTotal,
      shipments: shipmentTotal,
      inspections: inspectionTotal,
      admins: staffTotal,
    },
    meta: {
      source: 'database',
      page,
      pageSize,
      orders: orderTotal,
      customers: userTotal,
      lots: productTotal,
      auctions: auctionTotal,
      refunds: refundTotal,
    },
  };
}

const SETTING_KEYS = new Set(Object.keys(CONSOLE_SETTINGS_DEFAULTS));

export async function createConsoleCustomer(input: {
  fullName: string;
  email?: string;
  phone?: string;
  countryCode?: string;
  businessName?: string;
  role?: 'buyer' | 'seller' | 'both';
}) {
  const user = await userRepository.create({
    email: input.email,
    phone: input.phone,
    roles: [input.role ?? 'both'],
    profile: {
      fullName: input.fullName,
      countryCode: input.countryCode,
      companyName: input.businessName,
    },
  });
  const customerNo = await references.customerNo();
  await UserModel.updateOne(
    { _id: user.id },
    {
      $set: {
        customerNo,
        accountStatus: 'active',
        kycStatus: 'none',
        ...(input.businessName ? { 'business.name': input.businessName } : {}),
      },
    },
  );
  return { id: user.id, customerNo };
}

export async function updateConsoleCustomer(id: string, patch: { fullName?: string; businessName?: string; countryCode?: string }) {
  const set: Record<string, string> = {};
  if (patch.fullName) set['profile.fullName'] = patch.fullName;
  if (patch.businessName) set['business.name'] = patch.businessName;
  if (patch.countryCode) set['profile.countryCode'] = patch.countryCode;
  const updated = await UserModel.findByIdAndUpdate(id, { $set: set }, { new: true }).lean();
  if (!updated) throw notFound('customer/not-found', 'Customer not found');
  return { id: String(updated._id), customerNo: (updated as { customerNo?: string }).customerNo };
}

export async function reinstateConsoleCustomer(id: string, staff: { id: string; name: string }) {
  const updated = await UserModel.findByIdAndUpdate(
    id,
    { $set: { accountStatus: 'active', 'suspension.liftedAt': new Date(), 'suspension.liftedBy': { kind: 'staff', id: staff.id, name: staff.name } } },
    { new: true },
  ).lean();
  if (!updated) throw notFound('customer/not-found', 'Customer not found');
  void staff;
  return { ok: true, accountStatus: 'active' };
}

function gramsFrom(unit: string, amount: number): number {
  if (unit === 'kg') return Math.round(amount * 1000);
  if (unit === 't') return Math.round(amount * 1_000_000);
  return Math.round(amount);
}

export async function createConsoleLot(input: {
  name: string;
  mineral: string;
  unit: 'g' | 'kg' | 't';
  avail: number;
  origin: string;
  grade?: string;
  form?: string;
}) {
  if (!(input.avail >= 0)) throw unprocessable('Quantity must be zero or more.', { avail: 'Invalid' });
  const reference = await references.listing();
  const availableGrams = gramsFrom(input.unit, input.avail);
  // A lot filed under a catalogue subcategory takes its place in the hierarchy.
  const mineralType = await MineralTypeModel.findOne({ slug: input.mineral }).lean();
  const doc = await ProductModel.create({
    reference,
    name: input.name,
    typeSlug: input.mineral,
    categorySlug: mineralType?.categorySlug ?? 'general',
    ...(mineralType?.subcategorySlug ? { subcategorySlug: mineralType.subcategorySlug } : {}),
    mineralCode: mineralType?.mineralCode || input.mineral.replace(/[^a-z0-9]/gi, '').slice(0, 12).toUpperCase() || 'MIN',
    form: input.form,
    grade: input.grade,
    origin: { country: 'NG', display: input.origin },
    status: 'draft',
    availableGrams,
    minOrderGrams: 0,
    unitPriceMinorE4PerGram: 0,
    qty: { measure: 'mass', unit: input.unit, base: availableGrams * 1000 },
    seller: { name: 'Mineral Bridge', tier: 'mineral_bridge', verified: true },
    attributes: {},
    media: [],
    provenance: [],
    documents: [],
    assured: false,
    verified: false,
  });
  return { id: String(doc._id), reference: doc.reference, status: doc.status };
}

export async function updateConsoleLot(ref: string, patch: {
  name?: string; grade?: string; status?: 'listed' | 'draft' | 'sold out' | 'archived'; avail?: number; unit?: 'g' | 'kg' | 't';
  /** Smallest order, in the lot's unit (or `patch.unit`). */
  minOrder?: number;
  /** Reference price in major currency units per lot unit (or `patch.unit`). */
  referencePrice?: number;
}) {
  const status = patch.status === 'listed' ? 'active' : patch.status === 'sold out' ? 'sold' : patch.status === 'archived' ? 'withdrawn' : patch.status === 'draft' ? 'draft' : undefined;
  const set: Record<string, unknown> = {};
  if (patch.name) set.name = patch.name;
  if (patch.grade != null) set.grade = patch.grade;
  if (status) set.status = status;
  if (patch.avail != null) set.availableGrams = gramsFrom(patch.unit || 'g', patch.avail);
  if (patch.minOrder != null || patch.referencePrice != null) {
    const current = await ProductModel.findOne({ reference: ref }).lean();
    if (!current) throw notFound('lot/not-found', 'Lot not found');
    const unit = patch.unit || (['g', 'kg', 't'].includes(current.qty?.unit ?? '') ? (current.qty?.unit as 'g' | 'kg' | 't') : 'g');
    if (patch.minOrder != null) set.minOrderGrams = gramsFrom(unit, patch.minOrder);
    if (patch.referencePrice != null) set.unitPriceMinorE4PerGram = quotedPriceToE4PerGram(patch.referencePrice, unit);
  }
  const updated = await ProductModel.findOneAndUpdate({ reference: ref }, { $set: set }, { new: true }).lean();
  if (!updated) throw notFound('lot/not-found', 'Lot not found');
  return { reference: updated.reference, status: updated.status };
}

export async function deleteConsoleLot(ref: string) {
  const lot = await ProductModel.findOne({ reference: ref }).lean();
  if (!lot) throw notFound('lot/not-found', 'Lot not found');
  if (lot.status !== 'draft') throw conflict('lot/not-draft', 'Only draft lots can be deleted. Archive a listed lot instead.');
  const used = await OrderModel.countDocuments({ 'lines.productId': String(lot._id) });
  if (used) throw conflict('lot/in-use', 'This lot is already on an order and cannot be deleted.');
  await ProductModel.deleteOne({ _id: lot._id });
  return { ok: true };
}

export async function deleteConsoleAuction(idOrRef: string) {
  const auction = await AuctionModel.findOne({ $or: [{ _id: idOrRef }, { reference: idOrRef }] }).lean();
  if (!auction) throw notFound('auction/not-found', 'Auction not found');
  if (auction.status !== 'scheduled' && auction.status !== 'draft') {
    throw conflict('auction/not-scheduled', 'Only a scheduled auction with no bids can be deleted.');
  }
  if ((auction.bidCount ?? 0) > 0) throw conflict('auction/has-bids', 'This auction already has bids.');
  await AuctionModel.deleteOne({ _id: auction._id });
  return { ok: true };
}

export async function saveConsoleSettings(values: Record<string, unknown>) {
  const next: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!SETTING_KEYS.has(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') next[key] = value;
  }
  if (!Object.keys(next).length) throw unprocessable('No recognised settings.', { values: 'Empty' });
  const doc = await SettingsDoc.findOneAndUpdate(
    { key: 'platform' },
    { $set: Object.fromEntries(Object.entries(next).map(([k, v]) => [`values.${k}`, v])), $inc: { version: 1 } },
    { upsert: true, new: true },
  ).lean();
  return { version: doc?.version ?? 1, values: { ...CONSOLE_SETTINGS_DEFAULTS, ...(doc?.values ?? {}) } };
}

type TemplateRow = { id: string; name: string; ver: number; updated: number; body: string };

async function templateRows(): Promise<TemplateRow[]> {
  const doc = await SettingsDoc.findOne({ key: 'document_templates' }).lean();
  const rows = (doc?.values as { rows?: TemplateRow[] } | undefined)?.rows;
  return Array.isArray(rows) ? rows : [];
}

async function writeTemplates(rows: TemplateRow[], staffId: string) {
  await SettingsDoc.findOneAndUpdate(
    { key: 'document_templates' },
    { $set: { values: { rows }, updatedBy: staffId }, $inc: { version: 1 } },
    { upsert: true },
  );
}

export async function saveConsoleTemplate(input: { id?: string; name: string; body: string; staff: { id: string; name: string } }) {
  const name = input.name.trim();
  const body = input.body.trim();
  if (name.length < 2) throw unprocessable('Template name is required.', { name: 'Required' });
  if (body.length < 5) throw unprocessable('Template body is required.', { body: 'Required' });
  const rows = await templateRows();
  const now = Date.now();
  const existing = input.id ? rows.find((row) => row.id === input.id) : undefined;
  if (rows.some((row) => row.name.toLowerCase() === name.toLowerCase() && row.id !== existing?.id)) {
    throw conflict('template/duplicate', 'A template with that name exists.');
  }
  const saved: TemplateRow = existing
    ? { ...existing, name, body, ver: existing.ver + 1, updated: now }
    : { id: `TPL-${rows.length + 1}`, name, ver: 1, updated: now, body };
  const next = existing ? rows.map((row) => (row.id === existing.id ? saved : row)) : [...rows, saved];
  await writeTemplates(next, input.staff.id);
  await recordAudit({
    actor: { staffId: input.staff.id, name: input.staff.name },
    category: 'orders',
    action: existing ? 'Document template updated' : 'Document template created',
    record: { type: 'template', id: saved.id, label: saved.name },
  });
  return { ...saved, live: true };
}

export async function deleteConsoleTemplate(id: string, staff: { id: string; name: string }) {
  const rows = await templateRows();
  if (rows.length <= 1) throw conflict('template/last', 'At least one template must remain.');
  const found = rows.find((row) => row.id === id);
  if (!found) throw notFound('template/not-found', 'Template not found');
  await writeTemplates(rows.filter((row) => row.id !== id), staff.id);
  await recordAudit({
    actor: { staffId: staff.id, name: staff.name },
    category: 'orders',
    action: 'Document template deleted',
    record: { type: 'template', id, label: found.name },
  });
  return { ok: true };
}

export async function inviteConsoleAdmin(input: { name: string; email: string; roleKey: string; staff: { id: string; name: string } }) {
  const roleKey = input.roleKey.trim();
  const assigned = await resolveRole(roleKey);
  const email = input.email.trim().toLowerCase();
  if (!email.includes('@')) throw unprocessable('Enter a work email.', { email: 'Invalid' });
  const temporaryPassword = `Mb-${randomBytes(9).toString('base64url')}aA1`;
  const roleId = ROLE_ID_BY_KEY[roleKey];
  const created = roleId && getDefaultRole(roleId)
    ? await createStaff({ email, password: temporaryPassword, name: input.name.trim() || email, roleId })
    : await createStaff({
      email,
      password: temporaryPassword,
      name: input.name.trim() || email,
      role: { id: roleKey, name: assigned.label, scope: 'console' },
      permissions: noPermissions(),
    });
  await StaffModel.updateOne(
    { _id: created.id },
    {
      $set: {
        roleKey,
        actions: assigned.actions,
        actionsOverride: roleKey !== 'super' && (assigned.custom || assigned.customised),
        invitedBy: input.staff.id,
        invitedAt: new Date(),
        'mfa.enabled': false,
      },
    },
  );
  await recordAudit({
    actor: { staffId: input.staff.id, name: input.staff.name },
    category: 'orders',
    action: 'Admin invited',
    record: { type: 'staff', id: created.publicId, label: email },
    after: { roleKey },
  });
  return { id: created.publicId, email, roleKey, temporaryPassword };
}

export async function issueConsoleInvoice(ref: string, rate: number, staff: { id: string; name: string }) {
  if (!Number.isFinite(rate) || rate < 0) throw unprocessable('Enter a valid tax rate.', { rate: 'Invalid' });
  const order = await OrderModel.findOne({ reference: ref }).lean<IOrder>();
  if (!order) throw notFound('order/not-found', 'Order not found');
  const total = order.pricing?.lockedTotal ?? order.pricing?.quotedTotal ?? order.total;
  if (!total?.amountMinor) throw unprocessable('A quotation with a price is needed first.', { total: 'Missing' });
  const issued = await v2DocumentsService.issueFromOrder({
    orderId: String(order._id),
    type: 'tax_invoice',
    actor: { kind: 'staff', id: staff.id, name: staff.name },
    data: { rate, title: order.side === 'sell' ? 'Purchase invoice' : 'Tax invoice' },
  });
  await OrderModel.updateOne({ _id: order._id }, { $set: { 'links.invoiceNumber': issued.number, 'links.invoiceRate': rate } });
  await recordAudit({
    actor: { staffId: staff.id, name: staff.name },
    category: 'orders',
    action: 'Invoice issued',
    record: { type: 'document', id: issued.number, label: ref },
  });
  return issued;
}
