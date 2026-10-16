import type { MoneyDoc } from './_shared.js';
import { defineModel, pk, SubDocId } from './_shared.js';

export type OrderSide = 'buy' | 'sell';
/** Canonical statuses; mobile/web vocabularies are produced by the DTO mappers (X-7). */
export type OrderStatus = 'pending_review' | 'active' | 'completed' | 'rejected' | 'cancelled';
export type PaymentMethod = 'escrow' | 'wire' | 'lc' | 'btc';
export type EscrowState = 'not_funded' | 'held' | 'released' | 'refunded';

export interface IOrderLine {
  productId?: string;
  name: string;
  imageUrl?: string;
  grams: number;
  unitPriceMinorE4PerGram: number;
  lineTotalMinor: number;
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

export interface IOrder {
  _id: string;
  reference: string;
  userId: string;
  side: OrderSide;
  status: OrderStatus;
  /** 0-based index into the 6-stage pipeline for `side`. */
  stageIndex: number;
  stageHistory: { index: number; key: string; at: Date; note?: string }[];
  source: { kind: 'product' | 'cart' | 'lot' | 'auction' | 'listing' | 'sell_request'; refId?: string };
  lines: IOrderLine[];
  totalGrams: number;
  subtotal: MoneyDoc;
  platformFee: MoneyDoc;
  surcharge: MoneyDoc;
  total: MoneyDoc;
  paymentMethod: PaymentMethod;
  paymentTaken: boolean;
  quoteId?: string;
  delivery?: {
    addressId?: string;
    facilityName?: string;
    streetAddress?: string;
    city?: string;
    region?: string;
    country?: string;
    contactPerson?: string;
    contactPhone?: string;
    importPermitNumber?: string;
  };
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
  rejection?: { reason: string; stageIndex: number; at: Date };
  cancellation?: { reason?: string; at: Date; refundMinor: number };
  deliveryConfirmation?: { sealIntact: boolean; assayAccepted: boolean; note?: string; at: Date };
  documents: IOrderDocument[];
  /** Unique when set: guarantees one settlement order per auction win / listing, etc. */
  settlementKey?: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const OrderModel = defineModel<IOrder>(
  'Order',
  {
    _id: pk('ord'),
    reference: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    side: { type: String, enum: ['buy', 'sell'], required: true },
    status: {
      type: String,
      enum: ['pending_review', 'active', 'completed', 'rejected', 'cancelled'],
      default: 'pending_review',
    },
    stageIndex: { type: Number, default: 0, min: 0, max: 5 },
    stageHistory: [{ _id: false, index: Number, key: String, at: Date, note: String }],
    source: { kind: { type: String, required: true }, refId: String },
    lines: [
      {
        _id: SubDocId('oln'),
        productId: String,
        name: { type: String, required: true },
        imageUrl: String,
        grams: { type: Number, required: true },
        unitPriceMinorE4PerGram: { type: Number, required: true },
        lineTotalMinor: { type: Number, required: true },
      },
    ],
    totalGrams: { type: Number, required: true },
    subtotal: { type: Object, required: true },
    platformFee: { type: Object, required: true },
    surcharge: { type: Object, required: true },
    total: { type: Object, required: true },
    paymentMethod: { type: String, enum: ['escrow', 'wire', 'lc', 'btc'], default: 'escrow' },
    paymentTaken: { type: Boolean, default: false },
    quoteId: String,
    delivery: { type: Object },
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
    rejection: { reason: String, stageIndex: Number, at: Date },
    cancellation: { reason: String, at: Date, refundMinor: Number },
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
    settlementKey: { type: String },
    version: { type: Number, default: 0 },
  },
  {
    indexes: [
      [{ userId: 1, createdAt: -1 }],
      [{ userId: 1, side: 1, status: 1 }],
      [{ settlementKey: 1 }, { unique: true, partialFilterExpression: { settlementKey: { $type: 'string' } } }],
    ],
    schema: { minimize: false },
  },
);
