import type { MoneyDoc } from './_shared.js';
import { defineModel, pk } from './_shared.js';

export interface IEstimate {
  _id: string;
  userId: string;
  mineralTypeId: string;
  mineralName: string;
  grams: number;
  photoIds: string[];
  assumedPurityPct: number;
  low: MoneyDoc;
  high: MoneyDoc;
  midpoint: MoneyDoc;
  rateUnitMinorE4PerGram: number;
  rateAsOf: Date;
  deductionBps: number;
  expiresAt: Date;
  createdAt: Date;
}

export const EstimateModel = defineModel<IEstimate>('Estimate', {
  _id: pk('est'),
  userId: { type: String, required: true, index: true },
  mineralTypeId: { type: String, required: true },
  mineralName: String,
  grams: { type: Number, required: true },
  photoIds: [String],
  assumedPurityPct: Number,
  low: { type: Object, required: true },
  high: { type: Object, required: true },
  midpoint: { type: Object, required: true },
  rateUnitMinorE4PerGram: Number,
  rateAsOf: Date,
  deductionBps: Number,
  expiresAt: Date,
});

/** Sell request lifecycle (canonical). `offer_ready` pauses on review; terminal: sold/declined/expired/cancelled. */
export type SellStatus = 'booked' | 'evaluating' | 'offer_ready' | 'sold' | 'declined' | 'expired' | 'cancelled';
export type OfferStatus = 'open' | 'accepted' | 'declined' | 'expired' | 'withdrawn';

export interface ISellOffer {
  _id: string;
  status: OfferStatus;
  amount: MoneyDoc;
  issuedAt: Date;
  expiresAt: Date;
  validityHours: number;
  assay: { grams: number; karat: number; purityPct: number; evaluatedAt: Date; location?: string; tareGrams?: number };
  /** Set while a desk review is open: expiry clock is paused (M-4). */
  pausedAt?: Date;
  reviewTicketId?: string;
  decision?: { at: Date; reason?: string; note?: string; payoutAccountId?: string };
  version: number;
}

export interface ISellRequest {
  _id: string;
  reference: string;
  userId: string;
  tier: number;
  estimateId?: string;
  mineralTypeId: string;
  mineralName: string;
  grams: number;
  photoIds: string[];
  pickup: { addressId?: string; label?: string; display?: string };
  evaluation: { at: Date; slotKey: string };
  payoutAccountId?: string;
  status: SellStatus;
  timeline: { key: string; at: Date; sub?: string }[];
  evaluator?: { id: string; name: string; subtitle?: string; evaluationsCompleted?: number; onSite: boolean; checkedInAt?: Date };
  offer?: ISellOffer;
  estimateBand?: { low: MoneyDoc; high: MoneyDoc };
  /** Unique when active so one slot cannot be double booked (409 sell/slot-taken). */
  activeSlotKey?: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const SellRequestModel = defineModel<ISellRequest>(
  'SellRequest',
  {
    _id: pk('srq'),
    reference: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    tier: { type: Number, default: 1 },
    estimateId: String,
    mineralTypeId: { type: String, required: true },
    mineralName: String,
    grams: { type: Number, required: true },
    photoIds: [String],
    pickup: { addressId: String, label: String, display: String },
    evaluation: { at: Date, slotKey: String },
    payoutAccountId: String,
    status: {
      type: String,
      enum: ['booked', 'evaluating', 'offer_ready', 'sold', 'declined', 'expired', 'cancelled'],
      default: 'booked',
    },
    timeline: [{ _id: false, key: String, at: Date, sub: String }],
    evaluator: {
      id: String,
      name: String,
      subtitle: String,
      evaluationsCompleted: Number,
      onSite: Boolean,
      checkedInAt: Date,
    },
    offer: { type: Object },
    estimateBand: { type: Object },
    activeSlotKey: String,
    version: { type: Number, default: 0 },
  },
  {
    indexes: [
      [{ userId: 1, createdAt: -1 }],
      [{ activeSlotKey: 1 }, { unique: true, partialFilterExpression: { activeSlotKey: { $type: 'string' } } }],
    ],
    schema: { minimize: false },
  },
);

export type BulkStatus = 'desk_pricing' | 'document_check' | 'assay' | 'offer_issued' | 'accepted' | 'declined' | 'cancelled';

export interface IBulkQuote {
  _id: string;
  reference: string;
  userId: string;
  mineralTypeId: string;
  mineralName: string;
  grams: number;
  purityPct: number;
  photoIds: string[];
  offtakePartner?: string;
  origin?: { site?: string; extractionDate?: string };
  description?: string;
  facility: Record<string, string>;
  exportPermitNumber: string;
  proofOfAddressDocumentId?: string;
  status: BulkStatus;
  band: { low: MoneyDoc; high: MoneyDoc };
  deskReferenceE4PerGram: number;
  expectedOfferBy: Date;
  timeline: { key: string; at: Date; sub?: string }[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const BulkQuoteModel = defineModel<IBulkQuote>(
  'BulkQuote',
  {
    _id: pk('bqt'),
    reference: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    mineralTypeId: String,
    mineralName: String,
    grams: { type: Number, required: true },
    purityPct: Number,
    photoIds: [String],
    offtakePartner: String,
    origin: { site: String, extractionDate: String },
    description: String,
    facility: { type: Object },
    exportPermitNumber: String,
    proofOfAddressDocumentId: String,
    status: {
      type: String,
      enum: ['desk_pricing', 'document_check', 'assay', 'offer_issued', 'accepted', 'declined', 'cancelled'],
      default: 'desk_pricing',
    },
    band: { type: Object },
    deskReferenceE4PerGram: Number,
    expectedOfferBy: Date,
    timeline: [{ _id: false, key: String, at: Date, sub: String }],
    version: { type: Number, default: 0 },
  },
  { indexes: [[{ userId: 1, createdAt: -1 }]], schema: { minimize: false } },
);

/** Shared by sell-request documents (mobile) and listings (web). */
export interface ISellDocument {
  _id: string;
  requestId: string;
  name: string;
  kind: string;
  ready: boolean;
  fileId?: string;
  bytes?: number;
  contentType?: string;
  issuedAt?: Date;
}

export const SellDocumentModel = defineModel<ISellDocument>('SellDocument', {
  _id: pk('sdc'),
  requestId: { type: String, required: true, index: true },
  name: String,
  kind: String,
  ready: { type: Boolean, default: false },
  fileId: String,
  bytes: Number,
  contentType: String,
  issuedAt: Date,
});
