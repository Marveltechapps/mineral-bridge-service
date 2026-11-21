import type { ActorRef, QtyDoc } from './schema-primitives.js';
import type { MoneyDoc } from './_shared.js';
import { defineModel, pk, SubDocId } from './_shared.js';

export type OrderSide = 'buy' | 'sell';
/** Canonical statuses; mobile/web vocabularies are produced by the DTO mappers (X-7). */
export type OrderStatus = 'pending_review' | 'active' | 'completed' | 'rejected' | 'cancelled';
export type PaymentMethod =
  | 'escrow'
  | 'wire'
  | 'lc'
  | 'btc'
  | 'bank_transfer'
  | 'upi'
  | 'net_banking'
  | 'other';
export type EscrowState = 'not_funded' | 'held' | 'released' | 'refunded';
export type OrderSourceKind =
  | 'product'
  | 'cart'
  | 'lot'
  | 'auction'
  | 'listing'
  | 'sell_request'
  | 'app_sell_form'
  | 'admin';
export type WorkflowOwner = 'customer' | 'platform' | 'logistics' | 'inspector';
export type HoldType = 'declined' | 'discrepancy' | 'refund' | 'changes' | 'clarify';

export interface IOrderLine {
  productId?: string;
  name: string;
  imageUrl?: string;
  grams: number;
  unitPriceMinorE4PerGram: number;
  lineTotalMinor: number;
  qty?: QtyDoc;
  enteredAs?: string;
}

export interface IOrderDocument {
  _id: string;
  name: string;
  kind: string;
  availableFromStage: number;
  fileId?: string;
  contentType?: string;
  bytes?: number;
  issuedAt?: Date;
}

export interface IOrderWorkflow {
  definition: string;
  stepKey: string;
  stepIndex: number;
  phase: number;
  owner: WorkflowOwner;
  role?: string;
  enteredAt: Date;
}

export interface IOrderHold {
  type: HoldType;
  owner: string;
  role?: string;
  reason?: string;
  openedAt: Date;
  openedBy?: ActorRef;
}

export interface IOrder {
  _id: string;
  reference: string;
  userId: string;
  customerNo?: string;
  side: OrderSide;
  status: OrderStatus;
  /** 0-based index into the 6-stage pipeline for `side` (derived for v1). */
  stageIndex: number;
  stageHistory: { index: number; key: string; at: Date; note?: string }[];
  source: { kind: OrderSourceKind; refId?: string };
  /** Versioned workflow state (buy.v2 / sell.v2 / legacy.*). */
  workflow?: IOrderWorkflow;
  hold?: IOrderHold;
  timeline?: {
    stepKey: string;
    label: string;
    actor: ActorRef;
    note?: string;
    at: Date;
    data?: Record<string, unknown>;
  }[];
  lines: IOrderLine[];
  totalGrams: number;
  sell?: {
    mineralSlug: string;
    name: string;
    qty: QtyDoc;
    grade?: string;
    form?: string;
    details?: string;
    photoFileIds?: string[];
    documentFileIds?: string[];
    /** Photos staff received outside the app when they raise a sell request for a seller. */
    photosReceived?: number;
    declaredValue?: MoneyDoc;
  };
  subtotal: MoneyDoc;
  platformFee: MoneyDoc;
  surcharge: MoneyDoc;
  total: MoneyDoc;
  pricing?: {
    quotationId?: string;
    quotedTotal?: MoneyDoc;
    lockedTotal?: MoneyDoc;
    lockedAt?: Date;
    paymentEvidence?: string;
  };
  /** True only after the desk confirms the price agreed with the customer. */
  priceConfirmed?: boolean;
  paymentMethod: PaymentMethod;
  paymentTaken: boolean;
  quoteId?: string;
  buyerForm?: Record<string, unknown>;
  sellerForm?: Record<string, unknown>;
  delivery?: {
    addressId?: string;
    facilityName?: string;
    org?: string;
    streetAddress?: string;
    city?: string;
    region?: string;
    country?: string;
    contactPerson?: string;
    contactPhone?: string;
    importPermitNumber?: string;
  };
  links?: {
    contractId?: string;
    paymentId?: string;
    inspectionIds?: string[];
    shipmentId?: string;
    refundIds?: string[];
    payoutId?: string;
    auctionId?: string;
    negotiationId?: string;
    threadId?: string;
  };
  deliveryReport?: {
    qtyReceived?: string;
    condition?: string;
    note?: string;
    photoFileIds?: string[];
    at?: Date;
    resolution?: string;
  };
  refundSummary?: { refundedMinor: number; fullyRefunded: boolean };
  /** Sell-side price variations proposed by trading (ORD-18 / AORD-11). */
  priceVariations?: {
    _id: string;
    from: MoneyDoc;
    to: MoneyDoc;
    reason: 'qty' | 'grade' | 'both' | 'market' | 'other';
    note: string;
    status: 'awaiting_seller' | 'accepted' | 'rejected' | 'withdrawn';
    proposedBy: ActorRef;
    proposedAt: Date;
    decidedAt?: Date;
    decidedBy?: ActorRef;
    decisionNote?: string;
  }[];
  /** Pending change-request payload while hold.type === 'changes'. */
  pendingChanges?: {
    scope: 'submission' | 'seller_form';
    flaggedFileIds?: string[];
    note?: string;
    requestedAt?: Date;
    requestedBy?: ActorRef;
  };
  /** In-order trading negotiation (AORD-10 / ORD-24 offerMinor). */
  negotiation?: {
    messages: {
      _id: string;
      from: 'customer' | 'staff';
      who: string;
      text?: string;
      offerMinor?: number;
      currency?: string;
      at: Date;
    }[];
    closed?: boolean;
  };
  /** When an admin creates an order on behalf of a customer. */
  createdByStaff?: ActorRef;
  neededBy?: string;
  notes?: string;
  settlement: {
    method: PaymentMethod;
    status: EscrowState;
    escrowReference?: string;
    fundedAt?: Date;
    releasedAt?: Date;
    refundedAt?: Date;
  };
  assay?: { finalGrams: number; purity?: string; certifiedAt?: Date };
  seal?: { reference: string; photographedAt?: Date };
  carrier?: { name: string; bonded: boolean; escorts: number };
  eta?: { from: Date; to: Date };
  route?: { from: string; to: string; progress: number; lat?: number; lng?: number; updatedAt?: Date };
  counterparty?: { name: string; type: string; verified: boolean };
  region?: string;
  rejection?: { reason: string; stageIndex: number; at: Date; stepKey?: string; by?: ActorRef };
  cancellation?: { reason?: string; at: Date; refundMinor: number; note?: string; by?: ActorRef };
  /** Soft delete from the staff console. The row stays for audit; it is also `cancelled`. */
  deletedAt?: Date;
  deletedBy?: ActorRef;
  deleteReason?: string;
  deliveryConfirmation?: { sealIntact: boolean; assayAccepted: boolean; note?: string; at: Date };
  documents: IOrderDocument[];
  assignee?: { staffId: string; at: Date };
  /** Unique when set: guarantees one settlement order per auction win / listing, etc. */
  settlementKey?: string;
  version: number;
  migration?: { source?: string; batch?: string; legacyId?: string; totalDueOriginal?: number; reversible?: boolean };
  createdAt: Date;
  updatedAt: Date;
}

export const OrderModel = defineModel<IOrder>(
  'Order',
  {
    _id: pk('ord'),
    reference: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    customerNo: String,
    side: { type: String, enum: ['buy', 'sell'], required: true },
    status: {
      type: String,
      enum: ['pending_review', 'active', 'completed', 'rejected', 'cancelled'],
      default: 'pending_review',
    },
    stageIndex: { type: Number, default: 0, min: 0, max: 5 },
    stageHistory: [{ _id: false, index: Number, key: String, at: Date, note: String }],
    source: {
      kind: {
        type: String,
        enum: ['product', 'cart', 'lot', 'auction', 'listing', 'sell_request', 'app_sell_form', 'admin'],
        required: true,
      },
      refId: String,
    },
    workflow: {
      definition: String,
      stepKey: String,
      stepIndex: Number,
      phase: Number,
      owner: { type: String, enum: ['customer', 'platform', 'logistics', 'inspector'] },
      role: String,
      enteredAt: Date,
    },
    hold: {
      type: { type: String, enum: ['declined', 'discrepancy', 'refund', 'changes', 'clarify'] },
      owner: String,
      role: String,
      reason: String,
      openedAt: Date,
      openedBy: { kind: String, id: String, name: String, role: String },
    },
    timeline: {
      type: [
        {
          _id: false,
          stepKey: String,
          label: String,
          actor: { kind: String, id: String, name: String, role: String },
          note: String,
          at: Date,
          data: Object,
        },
      ],
      default: [],
    },
    lines: [
      {
        _id: SubDocId('oln'),
        productId: String,
        name: { type: String, required: true },
        imageUrl: String,
        grams: { type: Number, required: true },
        unitPriceMinorE4PerGram: { type: Number, required: true },
        lineTotalMinor: { type: Number, required: true },
        qty: { type: Object },
        enteredAs: String,
      },
    ],
    totalGrams: { type: Number, required: true },
    sell: { type: Object },
    subtotal: { type: Object, required: true },
    platformFee: { type: Object, required: true },
    surcharge: { type: Object, required: true },
    total: { type: Object, required: true },
    pricing: { type: Object },
    priceConfirmed: { type: Boolean, default: false },
    paymentMethod: {
      type: String,
      enum: ['escrow', 'wire', 'lc', 'btc', 'bank_transfer', 'upi', 'net_banking', 'other'],
      default: 'escrow',
    },
    paymentTaken: { type: Boolean, default: false },
    quoteId: String,
    buyerForm: { type: Object },
    sellerForm: { type: Object },
    delivery: { type: Object },
    links: { type: Object, default: {} },
    deliveryReport: { type: Object },
    refundSummary: {
      refundedMinor: { type: Number, default: 0 },
      fullyRefunded: { type: Boolean, default: false },
    },
    priceVariations: { type: [Object], default: [] },
    pendingChanges: { type: Object },
    negotiation: {
      messages: { type: [Object], default: [] },
      closed: { type: Boolean, default: false },
    },
    createdByStaff: { type: Object },
    neededBy: String,
    notes: String,
    settlement: {
      method: { type: String, default: 'escrow' },
      status: { type: String, enum: ['not_funded', 'held', 'released', 'refunded'], default: 'not_funded' },
      escrowReference: String,
      fundedAt: Date,
      releasedAt: Date,
      refundedAt: Date,
    },
    assay: { finalGrams: Number, purity: String, certifiedAt: Date },
    seal: { reference: String, photographedAt: Date },
    carrier: { name: String, bonded: Boolean, escorts: Number },
    eta: { from: Date, to: Date },
    route: { from: String, to: String, progress: Number, lat: Number, lng: Number, updatedAt: Date },
    counterparty: { type: Object },
    region: String,
    rejection: { reason: String, stageIndex: Number, at: Date, stepKey: String, by: Object },
    cancellation: { reason: String, at: Date, refundMinor: Number, note: String, by: Object },
    deletedAt: Date,
    deletedBy: { type: Object },
    deleteReason: String,
    deliveryConfirmation: { sealIntact: Boolean, assayAccepted: Boolean, note: String, at: Date },
    documents: [
      {
        _id: SubDocId('doc'),
        name: String,
        kind: String,
        availableFromStage: { type: Number, default: 0 },
        fileId: String,
        contentType: String,
        bytes: Number,
        issuedAt: Date,
      },
    ],
    assignee: { staffId: String, at: Date },
    settlementKey: { type: String },
    version: { type: Number, default: 0 },
    /** Present only on rows copied by the legacy checkout migration. */
    migration: { type: Object },
  },
  {
    indexes: [
      [{ userId: 1, createdAt: -1 }],
      [{ userId: 1, side: 1, status: 1 }],
      [{ settlementKey: 1 }, { unique: true, partialFilterExpression: { settlementKey: { $type: 'string' } } }],
      [{ side: 1, 'workflow.stepKey': 1, 'workflow.enteredAt': 1 }],
      [{ 'workflow.owner': 1, 'workflow.role': 1, 'workflow.enteredAt': 1 }],
      [{ 'hold.type': 1 }, { sparse: true }],
      [{ customerNo: 1, createdAt: -1 }],
      [{ 'links.auctionId': 1 }, { sparse: true }],
      [{ status: 1, updatedAt: -1 }],
    ],
    schema: { minimize: false },
  },
);
