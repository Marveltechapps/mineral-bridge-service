import type { MoneyDoc } from './_shared.js';
import { defineModel, pk } from './_shared.js';
import type { ActorRef, EntityRef, QtyDoc } from './schema-primitives.js';

/* ───────── Inventory movements ───────── */

export type InventoryMovementKind = 'reserve' | 'release' | 'sell' | 'receive' | 'adjust';

export interface IInventoryMovement {
  _id: string;
  productId: string;
  kind: InventoryMovementKind;
  deltaBase: number;
  availableAfterBase: number;
  reservedAfterBase: number;
  orderId?: string;
  reason?: string;
  actor: ActorRef;
  createdAt: Date;
  updatedAt: Date;
}

export const InventoryMovementModel = defineModel<IInventoryMovement>(
  'InventoryMovement',
  {
    _id: pk('imv'),
    productId: { type: String, required: true },
    kind: { type: String, enum: ['reserve', 'release', 'sell', 'receive', 'adjust'], required: true },
    deltaBase: { type: Number, required: true, validate: Number.isSafeInteger },
    availableAfterBase: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
    reservedAfterBase: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
    orderId: String,
    reason: { type: String, maxlength: 300 },
    actor: { type: Object, required: true },
  },
  {
    indexes: [
      [{ productId: 1, createdAt: -1 }],
      [
        { orderId: 1, kind: 1 },
        {
          unique: true,
          partialFilterExpression: {
            orderId: { $type: 'string' },
            kind: { $in: ['reserve', 'release', 'sell'] },
          },
        },
      ],
    ],
  },
);

/* ───────── Quotations ───────── */

export type QuotationStatus = 'issued' | 'accepted' | 'declined' | 'replaced' | 'expired';

export interface IQuotationLine {
  name: string;
  qty: QtyDoc;
  price: MoneyDoc;
}

export interface IQuotation {
  _id: string;
  orderId: string;
  number: string;
  rev: number;
  lines: IQuotationLine[];
  product: MoneyDoc;
  fee: MoneyDoc;
  transport: MoneyDoc;
  other?: { label: string; amount: MoneyDoc };
  deduction?: { label: string; amount: MoneyDoc };
  total: MoneyDoc;
  rateNote?: string;
  conditions?: string;
  validUntil: Date;
  status: QuotationStatus;
  decision?: { at: Date; by: ActorRef; reason?: string };
  issuedBy: ActorRef;
  issuedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const QuotationModel = defineModel<IQuotation>(
  'Quotation',
  {
    _id: pk('qtn'),
    orderId: { type: String, required: true },
    number: { type: String, required: true, unique: true },
    rev: { type: Number, required: true, min: 1, default: 1 },
    lines: [
      {
        _id: false,
        name: { type: String, required: true },
        qty: { type: Object, required: true },
        price: { type: Object, required: true },
      },
    ],
    product: { type: Object, required: true },
    fee: { type: Object, required: true },
    transport: { type: Object, required: true },
    other: { type: Object },
    deduction: { type: Object },
    total: { type: Object, required: true },
    rateNote: { type: String, maxlength: 200 },
    conditions: String,
    validUntil: { type: Date, required: true },
    status: {
      type: String,
      enum: ['issued', 'accepted', 'declined', 'replaced', 'expired'],
      default: 'issued',
    },
    decision: { type: Object },
    issuedBy: { type: Object, required: true },
    issuedAt: { type: Date, required: true },
  },
  {
    indexes: [
      [{ orderId: 1, rev: -1 }],
      [{ orderId: 1 }, { unique: true, partialFilterExpression: { status: 'issued' } }],
      [{ status: 1, validUntil: 1 }],
    ],
    schema: { minimize: false },
  },
);

/* ───────── Payments (incoming) ───────── */

export type PaymentMethodV2 =
  | 'bank_transfer'
  | 'upi'
  | 'net_banking'
  | 'btc'
  | 'lc'
  | 'other'
  | 'escrow'
  | 'wire';

export type PaymentStatus =
  | 'initiated'
  | 'submitted'
  | 'confirming'
  | 'confirmed'
  | 'failed'
  | 'expired'
  | 'cancelled';

export interface IPayment {
  _id: string;
  orderId: string;
  userId: string;
  method: PaymentMethodV2;
  amount: MoneyDoc;
  status: PaymentStatus;
  attempt: number;
  proofFileIds: string[];
  payerBank?: string;
  gateway?: { provider: string; reference: string; status?: string; raw?: Record<string, unknown> };
  btc?: {
    rateMinorPerBtc: number;
    amountSats: number;
    address: string;
    txid?: string;
    confirmations?: number;
    requiredConfirmations?: number;
    lockExpiresAt?: Date;
  };
  lc?: { issuingBank?: string; number?: string; fileIds?: string[] };
  confirmedRef?: string;
  confirmedBy?: ActorRef;
  confirmedAt?: Date;
  failure?: { code: string; reason: string; at: Date };
  idempotencyKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

export const PaymentModel = defineModel<IPayment>(
  'Payment',
  {
    _id: pk('pmt'),
    orderId: { type: String, required: true },
    userId: { type: String, required: true },
    method: {
      type: String,
      enum: ['bank_transfer', 'upi', 'net_banking', 'btc', 'lc', 'other', 'escrow', 'wire'],
      required: true,
    },
    amount: { type: Object, required: true },
    status: {
      type: String,
      enum: ['initiated', 'submitted', 'confirming', 'confirmed', 'failed', 'expired', 'cancelled'],
      default: 'submitted',
    },
    attempt: { type: Number, default: 1, min: 1 },
    proofFileIds: { type: [String], default: [] },
    payerBank: { type: String, maxlength: 120 },
    gateway: { type: Object },
    btc: { type: Object },
    lc: { type: Object },
    confirmedRef: String,
    confirmedBy: { type: Object },
    confirmedAt: Date,
    failure: { type: Object },
    idempotencyKey: String,
  },
  {
    indexes: [
      [{ orderId: 1, attempt: -1 }],
      [
        { orderId: 1 },
        {
          unique: true,
          partialFilterExpression: { status: { $in: ['initiated', 'submitted', 'confirming'] } },
        },
      ],
      [{ status: 1, createdAt: 1 }],
      [{ 'btc.txid': 1 }, { unique: true, sparse: true }],
      [{ 'gateway.reference': 1 }, { unique: true, sparse: true }],
    ],
    schema: { minimize: false },
  },
);

/* ───────── Seller payouts ───────── */

export type SellerPayoutStatus = 'pending_approval' | 'approved' | 'released' | 'failed' | 'cancelled';

export interface ISellerPayout {
  _id: string;
  orderId: string;
  userId: string;
  amount: MoneyDoc;
  destination: {
    payoutAccountId: string;
    method: 'bank' | 'upi' | 'mobile_money' | 'btc';
    display: string;
  };
  status: SellerPayoutStatus;
  approvals: { staffId: string; at: Date }[];
  releasedRef?: string;
  releasedAt?: Date;
  releasedBy?: ActorRef;
  settlementId?: string;
  failure?: { code: string; reason: string };
  createdAt: Date;
  updatedAt: Date;
}

/** Collection `cust_payouts` — seller payouts (distinct from withdrawals `pay_…`). */
export const SellerPayoutModel = defineModel<ISellerPayout>(
  'Payout',
  {
    _id: pk('pyo'),
    orderId: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    amount: { type: Object, required: true },
    destination: {
      payoutAccountId: { type: String, required: true },
      method: { type: String, enum: ['bank', 'upi', 'mobile_money', 'btc'], required: true },
      display: { type: String, required: true },
    },
    status: {
      type: String,
      enum: ['pending_approval', 'approved', 'released', 'failed', 'cancelled'],
      default: 'pending_approval',
    },
    approvals: { type: [{ _id: false, staffId: String, at: Date }], default: [] },
    releasedRef: String,
    releasedAt: Date,
    releasedBy: { type: Object },
    settlementId: String,
    failure: { type: Object },
  },
  {
    indexes: [[{ status: 1, createdAt: 1 }], [{ userId: 1, createdAt: -1 }]],
    schema: { minimize: false },
  },
);

/* ───────── Refunds ───────── */

export type RefundType = 'full' | 'partial';
export type RefundReason =
  | 'delivery_delayed'
  | 'quantity_quality'
  | 'damaged'
  | 'paid_twice'
  | 'no_longer_needed'
  | 'other';
export type RefundStatus = 'requested' | 'review' | 'approved' | 'processing' | 'refunded' | 'declined';

export interface IRefund {
  _id: string;
  reference: string;
  orderId: string;
  userId: string;
  type: RefundType;
  amount: MoneyDoc;
  reason: RefundReason;
  note: string;
  attachmentFileIds: string[];
  destination: {
    method: 'original' | 'bank' | 'upi' | 'btc';
    holder?: string;
    bankName?: string;
    accountMasked?: string;
    accountEnc?: string;
    swiftOrIfsc?: string;
    country?: string;
    upiId?: string;
    btcAddress?: string;
    label?: string;
  };
  fromDiscrepancy: boolean;
  cancelOrderOnApproval: boolean;
  status: RefundStatus;
  decisions: { action: string; by: ActorRef; at: Date; reason?: string }[];
  approvals: { staffId: string; at: Date }[];
  bankRef?: string;
  refundedAt?: Date;
  dueBy: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const RefundModel = defineModel<IRefund>(
  'Refund',
  {
    _id: pk('rfd'),
    reference: { type: String, required: true, unique: true },
    orderId: { type: String, required: true },
    userId: { type: String, required: true },
    type: { type: String, enum: ['full', 'partial'], required: true },
    amount: { type: Object, required: true },
    reason: {
      type: String,
      enum: ['delivery_delayed', 'quantity_quality', 'damaged', 'paid_twice', 'no_longer_needed', 'other'],
      required: true,
    },
    note: { type: String, required: true, minlength: 10, maxlength: 2000 },
    attachmentFileIds: { type: [String], default: [] },
    destination: {
      method: { type: String, enum: ['original', 'bank', 'upi', 'btc'], required: true },
      holder: String,
      bankName: String,
      accountMasked: String,
      accountEnc: { type: String, select: false },
      swiftOrIfsc: String,
      country: String,
      upiId: { type: String, select: false },
      btcAddress: { type: String, select: false },
      label: String,
    },
    fromDiscrepancy: { type: Boolean, default: false },
    cancelOrderOnApproval: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ['requested', 'review', 'approved', 'processing', 'refunded', 'declined'],
      default: 'requested',
    },
    decisions: { type: [{ _id: false, action: String, by: Object, at: Date, reason: String }], default: [] },
    approvals: { type: [{ _id: false, staffId: String, at: Date }], default: [] },
    bankRef: String,
    refundedAt: Date,
    dueBy: { type: Date, required: true },
  },
  {
    indexes: [
      [{ orderId: 1, createdAt: -1 }],
      [
        { orderId: 1 },
        {
          unique: true,
          partialFilterExpression: { status: { $in: ['requested', 'review', 'approved', 'processing'] } },
        },
      ],
      [{ status: 1, dueBy: 1 }],
    ],
    schema: { minimize: false },
  },
);

/* ───────── Inspections ───────── */

export type InspectionType = 'platform_onsite' | 'third_party';
export type InspectionStatus =
  | 'scheduled'
  | 'completed'
  | 'report_uploaded'
  | 'accepted'
  | 'queried'
  | 'cancelled';

export interface IInspection {
  _id: string;
  orderId: string;
  type: InspectionType;
  agencyPartnerId?: string;
  inspectorPartnerId?: string;
  schedule: {
    date: string;
    time: string;
    location: string;
    scheduledBy: ActorRef;
    at: Date;
  };
  status: InspectionStatus;
  findings?: {
    weight: QtyDoc;
    sampleNo?: string;
    seals?: string;
    photoFileIds?: string[];
    result?: string;
    notes?: string;
    by?: ActorRef;
    at?: Date;
  };
  report?: {
    certificateNo: string;
    grade?: string;
    net: QtyDoc;
    result: 'compliant' | 'non_compliant';
    fileId?: string;
    uploadedBy?: ActorRef;
    at?: Date;
  };
  customerReview?: {
    accepted?: boolean;
    at?: Date;
    query?: string;
    answeredAt?: Date;
    answer?: string;
  };
  variancePct?: number;
  createdAt: Date;
  updatedAt: Date;
}

export const InspectionModel = defineModel<IInspection>(
  'Inspection',
  {
    _id: pk('ins'),
    orderId: { type: String, required: true },
    type: { type: String, enum: ['platform_onsite', 'third_party'], required: true },
    agencyPartnerId: String,
    inspectorPartnerId: String,
    schedule: {
      date: { type: String, required: true },
      time: { type: String, required: true },
      location: { type: String, required: true },
      scheduledBy: { type: Object, required: true },
      at: { type: Date, required: true },
    },
    status: {
      type: String,
      enum: ['scheduled', 'completed', 'report_uploaded', 'accepted', 'queried', 'cancelled'],
      default: 'scheduled',
    },
    findings: { type: Object },
    report: { type: Object },
    customerReview: { type: Object },
    variancePct: Number,
  },
  {
    indexes: [
      [{ orderId: 1, type: 1 }],
      [{ status: 1, 'schedule.date': 1 }],
      [{ agencyPartnerId: 1, 'schedule.date': 1 }],
    ],
    schema: { minimize: false },
  },
);

/* ───────── Issued documents ───────── */

export type IssuedDocumentType =
  | 'quotation'
  | 'e_contract'
  | 'sell_e_contract'
  | 'auction_terms'
  | 'auction_result'
  | 'payment_receipt'
  | 'tax_invoice'
  | 'inspection_report'
  | 'test_certificate'
  | 'payment_advice'
  | 'consignment_note'
  | 'proof_of_delivery'
  | 'completion_certificate'
  | 'refund_receipt'
  | 'cancellation_confirmation';

export type IssuedDocumentStatus = 'processing' | 'issued' | 'replaced' | 'cancelled';

export interface IIssuedDocument {
  _id: string;
  number: string;
  type: IssuedDocumentType;
  entity: EntityRef;
  userId?: string;
  version: number;
  status: IssuedDocumentStatus;
  templateId?: string;
  templateVersion?: number;
  fileId?: string;
  data?: Record<string, unknown>;
  issuedBy: ActorRef;
  issuedAt: Date;
  replacedBy?: string;
  cancelReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export const IssuedDocumentModel = defineModel<IIssuedDocument>(
  'IssuedDocument',
  {
    _id: pk('idc'),
    number: { type: String, required: true },
    type: {
      type: String,
      enum: [
        'quotation',
        'e_contract',
        'sell_e_contract',
        'auction_terms',
        'auction_result',
        'payment_receipt',
        'tax_invoice',
        'inspection_report',
        'test_certificate',
        'payment_advice',
        'consignment_note',
        'proof_of_delivery',
        'completion_certificate',
        'refund_receipt',
        'cancellation_confirmation',
      ],
      required: true,
    },
    entity: { type: Object, required: true },
    userId: String,
    version: { type: Number, required: true, min: 1, default: 1 },
    status: {
      type: String,
      enum: ['processing', 'issued', 'replaced', 'cancelled'],
      default: 'processing',
    },
    templateId: String,
    templateVersion: Number,
    fileId: String,
    data: { type: Object },
    issuedBy: { type: Object, required: true },
    issuedAt: { type: Date, required: true },
    replacedBy: String,
    cancelReason: String,
  },
  {
    indexes: [
      [{ number: 1, version: 1 }, { unique: true }],
      [{ number: 1 }, { unique: true, partialFilterExpression: { status: 'issued' } }],
      [{ 'entity.type': 1, 'entity.id': 1, issuedAt: -1 }],
      [{ type: 1, status: 1 }],
      [{ userId: 1, issuedAt: -1 }],
    ],
    schema: { minimize: false },
  },
);

/* ───────── Document templates ───────── */

export interface IDocumentTemplate {
  _id: string;
  type: IssuedDocumentType | string;
  name: string;
  version: number;
  body: string;
  active: boolean;
  editedBy?: ActorRef;
  editedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const DocumentTemplateModel = defineModel<IDocumentTemplate>(
  'DocumentTemplate',
  {
    _id: pk('dtp'),
    type: { type: String, required: true },
    name: { type: String, required: true },
    version: { type: Number, required: true, min: 1, default: 1 },
    body: { type: String, required: true },
    active: { type: Boolean, default: false },
    editedBy: { type: Object },
    editedAt: Date,
  },
  {
    indexes: [
      [{ type: 1, version: -1 }, { unique: true }],
      [{ type: 1 }, { unique: true, partialFilterExpression: { active: true } }],
    ],
  },
);

/* ───────── Notification delivery attempts ───────── */

export type DeliveryChannel = 'push' | 'email' | 'sms' | 'whatsapp' | 'in_app';
export type DeliveryAttemptStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'skipped';

export interface IDeliveryAttempt {
  _id: string;
  notificationId: string;
  userId: string;
  channel: DeliveryChannel;
  destination?: string;
  template: string;
  status: DeliveryAttemptStatus;
  provider?: string;
  providerRef?: string;
  error?: { code: string; message: string };
  attempt: number;
  nextRetryAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const DeliveryAttemptModel = defineModel<IDeliveryAttempt>(
  'DeliveryAttempt',
  {
    _id: pk('dla'),
    notificationId: { type: String, required: true },
    userId: { type: String, required: true },
    channel: { type: String, enum: ['push', 'email', 'sms', 'whatsapp', 'in_app'], required: true },
    destination: String,
    template: { type: String, required: true },
    status: {
      type: String,
      enum: ['queued', 'sent', 'delivered', 'failed', 'skipped'],
      default: 'queued',
    },
    provider: String,
    providerRef: String,
    error: { type: Object },
    attempt: { type: Number, required: true, min: 1, default: 1 },
    nextRetryAt: Date,
  },
  {
    indexes: [
      [{ notificationId: 1, channel: 1, attempt: -1 }],
      [{ status: 1, nextRetryAt: 1 }],
      [{ userId: 1, createdAt: -1 }],
      [{ providerRef: 1 }, { sparse: true }],
      [{ createdAt: 1 }, { expireAfterSeconds: 400 * 24 * 60 * 60 }],
    ],
  },
);

/* ───────── Transactional outbox ───────── */

export type OutboxStatus = 'pending' | 'published' | 'failed';

export interface IOutboxEvent {
  _id: string;
  type: string;
  aggregate: EntityRef;
  payload: Record<string, unknown>;
  audience: { userIds: string[]; staffRoles: string[] };
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const OutboxEventModel = defineModel<IOutboxEvent>(
  'OutboxEvent',
  {
    _id: pk('obx'),
    type: { type: String, required: true },
    aggregate: { type: Object, required: true },
    payload: { type: Object, default: {} },
    audience: {
      userIds: { type: [String], default: [] },
      staffRoles: { type: [String], default: [] },
    },
    status: { type: String, enum: ['pending', 'published', 'failed'], default: 'pending' },
    attempts: { type: Number, default: 0, min: 0 },
    nextAttemptAt: Date,
    publishedAt: Date,
  },
  {
    indexes: [
      [{ status: 1, nextAttemptAt: 1 }],
      [{ publishedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 }],
    ],
  },
);

/* ───────── Migration checkpoints ───────── */

export interface IMigrationCheckpoint {
  _id: string;
  lastId?: string;
  counts: Record<string, number>;
  startedAt?: Date;
  finishedAt?: Date;
  report?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export const MigrationCheckpointModel = defineModel<IMigrationCheckpoint>(
  'Migration',
  {
    _id: { type: String, required: true },
    lastId: String,
    counts: { type: Object, default: {} },
    startedAt: Date,
    finishedAt: Date,
    report: { type: Object },
  },
);
