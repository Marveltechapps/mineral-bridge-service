import type { ActorRef, QtyDoc } from './schema-primitives.js';
import type { MoneyDoc } from './_shared.js';
import { defineModel, pk } from './_shared.js';

/** Canonical auction states. Mobile maps ended+unsold -> reserve_not_met; web -> unsold (X-7). */
export type AuctionStatus = 'draft' | 'scheduled' | 'live' | 'paused' | 'ended' | 'cancelled';
export type BidKind = 'manual' | 'auto' | 'opening';
export type AuctionAccess = 'all_verified' | 'tier2_plus' | 'tier3_only';

export interface IAuction {
  _id: string;
  reference: string;
  name: string;
  productId?: string;
  quantityGrams: number;
  qty?: QtyDoc;
  grade?: string;
  origin?: string;
  description?: string;
  specs: { label: string; value: string }[];
  badges: { kind: string; label: string }[];
  sampling?: { by: string; at: Date; moisturePercent?: number };
  settlementTerms: string;
  currency: string;
  startingBid: MoneyDoc;
  minimumIncrement: MoneyDoc;
  quickIncrements: number[];
  reserve?: MoneyDoc;
  opensAt: Date;
  closesAt: Date;
  originalClosesAt: Date;
  status: AuctionStatus;
  access?: AuctionAccess;
  flags?: { kind: string; note?: string; bidIds?: string[]; by?: ActorRef; at: Date }[];
  risk?: { kind: string; text: string; at: Date };
  cancelReason?: string;
  relist?: { action: string; at: Date; refId?: string; by?: ActorRef };
  createdBy?: ActorRef;
  awardedOrderId?: string;
  /** Optimistic-concurrency counter; incremented on every accepted bid / extension. */
  version: number;
  bidCount: number;
  highest?: { bidId: string; bidderId: string; amountMinor: number; placedAt: Date };
  extensions: number;
  outcome?: {
    result: 'sold' | 'reserve_not_met' | 'no_bids';
    winnerId?: string;
    winningMinor?: number;
    settlementOrderId?: string;
    finalizedAt: Date;
  };
  imageUrl?: string;
  gradientFrom?: string;
  gradientTo?: string;
  mediaCount: number;
  assured: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const AuctionModel = defineModel<IAuction>(
  'Auction',
  {
    _id: pk('auc'),
    reference: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    productId: String,
    quantityGrams: { type: Number, required: true },
    qty: { type: Object },
    grade: String,
    origin: String,
    description: String,
    specs: [{ _id: false, label: String, value: String }],
    badges: [{ _id: false, kind: String, label: String }],
    sampling: { by: String, at: Date, moisturePercent: Number },
    settlementTerms: { type: String, default: 'Escrow · 48h after close' },
    currency: { type: String, default: 'USD' },
    startingBid: { type: Object, required: true },
    minimumIncrement: { type: Object, required: true },
    quickIncrements: { type: [Number], default: [] },
    reserve: { type: Object },
    opensAt: { type: Date, required: true },
    closesAt: { type: Date, required: true },
    originalClosesAt: { type: Date, required: true },
    status: {
      type: String,
      enum: ['draft', 'scheduled', 'live', 'paused', 'ended', 'cancelled'],
      default: 'scheduled',
    },
    version: { type: Number, default: 0 },
    bidCount: { type: Number, default: 0 },
    highest: { bidId: String, bidderId: String, amountMinor: Number, placedAt: Date },
    extensions: { type: Number, default: 0 },
    outcome: {
      result: { type: String, enum: ['sold', 'reserve_not_met', 'no_bids'] },
      winnerId: String,
      winningMinor: Number,
      settlementOrderId: String,
      finalizedAt: Date,
    },
    imageUrl: String,
    gradientFrom: String,
    gradientTo: String,
    mediaCount: { type: Number, default: 0 },
    assured: { type: Boolean, default: false },
    access: { type: String, enum: ['all_verified', 'tier2_plus', 'tier3_only'], default: 'all_verified' },
    flags: [
      {
        _id: false,
        kind: String,
        note: String,
        bidIds: [String],
        by: Object,
        at: Date,
      },
    ],
    risk: { kind: String, text: String, at: Date },
    cancelReason: String,
    relist: { action: String, at: Date, refId: String, by: Object },
    createdBy: { type: Object },
    awardedOrderId: String,
  },
  {
    indexes: [[{ status: 1, closesAt: 1 }], [{ opensAt: 1 }], [{ productId: 1, status: 1 }]],
    schema: { minimize: false },
  },
);

export interface IBid {
  _id: string;
  auctionId: string;
  bidderId: string;
  amountMinor: number;
  currency: string;
  kind: BidKind;
  /** Auction `version` right after this bid was accepted; unique per auction => total order of bids. */
  seq: number;
  placedAt: Date;
  idempotencyKey?: string;
}

export const BidModel = defineModel<IBid>(
  'Bid',
  {
    _id: pk('bid'),
    auctionId: { type: String, required: true },
    bidderId: { type: String, required: true },
    amountMinor: { type: Number, required: true, validate: Number.isSafeInteger },
    currency: { type: String, default: 'USD' },
    kind: { type: String, enum: ['manual', 'auto', 'opening'], default: 'manual' },
    seq: { type: Number, required: true },
    placedAt: { type: Date, required: true },
    idempotencyKey: String,
  },
  {
    indexes: [
      [{ auctionId: 1, seq: 1 }, { unique: true }],
      [{ auctionId: 1, amountMinor: -1 }],
      [{ bidderId: 1, placedAt: -1 }],
    ],
  },
);

export interface IAutoBid {
  _id: string;
  auctionId: string;
  userId: string;
  ceilingMinor: number;
  currency: string;
  active: boolean;
}

export const AutoBidModel = defineModel<IAutoBid>(
  'AutoBid',
  {
    _id: pk('abd'),
    auctionId: { type: String, required: true },
    userId: { type: String, required: true },
    ceilingMinor: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    active: { type: Boolean, default: true },
  },
  { indexes: [[{ auctionId: 1, userId: 1 }, { unique: true }]] },
);

/** Mobile "watch" (notifyOnSimilar) and web "reminder" share one collection. */
export interface IAuctionWatch {
  _id: string;
  auctionId: string;
  userId: string;
  kind: 'watch' | 'reminder';
  notifyOnSimilar: boolean;
  channels: string[];
  notifyAt?: Date;
}

export const AuctionWatchModel = defineModel<IAuctionWatch>(
  'AuctionWatch',
  {
    _id: pk('awt'),
    auctionId: { type: String, required: true },
    userId: { type: String, required: true },
    kind: { type: String, enum: ['watch', 'reminder'], required: true },
    notifyOnSimilar: { type: Boolean, default: false },
    channels: { type: [String], default: [] },
    notifyAt: Date,
  },
  { indexes: [[{ auctionId: 1, userId: 1, kind: 1 }, { unique: true }]] },
);
