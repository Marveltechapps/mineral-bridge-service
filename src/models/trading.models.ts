import { Schema } from 'mongoose';
import { defineModel, timestampFields } from '../common/db/define-model.js';
import {
  AUCTION_STATUSES,
  BUYER_ACCESS,
  LISTING_STATUSES,
  LOT_STATUSES,
  ORDER_STAGES,
  SETTLEMENT_KINDS,
  SETTLEMENT_STATUSES,
} from '../modules/admin/shared/enums.js';
import { moneySchema, quantitySchema, refSchema, unitPriceSchema } from './shared.js';

const opts = { timestamps: true } as const;
const mineralSub = new Schema<any>({ id: String, name: { type: String, required: true } }, { _id: false });

/* ───────── Orders ───────── */
const orderSchema = new Schema<any>(
  {
    orderId: { type: String, required: true, unique: true },
    side: { type: String, enum: ['buy', 'sell'], required: true },
    status: { type: String, enum: ['draft', 'active', 'completed', 'cancelled'], default: 'active' },
    mineral: { type: mineralSub, required: true },
    grade: String,
    counterpartyId: { type: String, required: true, index: true },
    quantity: { type: quantitySchema, required: true },
    stage: { type: String, enum: ORDER_STAGES, default: 'verification' },
    stageEnteredAt: { type: Date, default: Date.now },
    /** Total ms the stage clock was paused by hold_order exceptions in the current stage. */
    stagePausedMs: { type: Number, default: 0 },
    openedAt: { type: Date, default: Date.now },
    agentId: { type: String, index: true },
    value: moneySchema,
    lockedRate: unitPriceSchema,
    assayStatus: { type: String, default: 'pending' },
    paymentStatus: { type: String, enum: ['due_on_approval', 'released'], default: 'due_on_approval' },
    releasedAmount: moneySchema,
    sealNo: String,
    carrierId: String,
    hubId: String,
    labId: String,
    escrowRef: String,
    origin: String,
    destination: String,
    note: String,
    stageLog: [
      {
        _id: false,
        stage: String,
        at: Date,
        agentId: String,
        description: String,
      },
    ],
    route: {
      direction: { type: String, enum: ['seller_to_vault', 'vault_to_buyer'] },
      eta: Date,
      summary: String,
      stops: [{ _id: false, kind: String, name: String, place: String, state: String, note: String }],
    },
    documents: [{ _id: false, id: String, name: String, ref: String, status: { type: String, default: 'in_review' }, fileId: String }],
    history: [{ _id: false, text: String, actorId: String, at: Date }],
    exceptions: [
      {
        _id: false,
        id: String,
        type: { type: String },
        severity: { type: String, enum: ['note', 'hold_order'] },
        description: String,
        openedAt: Date,
        openedBy: String,
        status: { type: String, enum: ['open', 'cleared', 'draft'], default: 'open' },
        holdStartedAt: Date,
      },
    ],
    linkedLcId: String,
    lotId: String,
    listingId: String,
    auctionId: String,
    createdBy: String,
    ...timestampFields,
  },
  opts,
);
orderSchema.index({ side: 1, stage: 1, openedAt: -1 });
orderSchema.index({ status: 1 });
export const Order = defineModel('Order', orderSchema, 'orders');

/* ───────── Bulk intake (Tier 3 consignments) ───────── */
const intakeSchema = new Schema<any>(
  {
    intakeId: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    mineral: { type: mineralSub, required: true },
    quantity: { type: quantitySchema, required: true },
    grade: String,
    liveRate: unitPriceSchema,
    suggested: moneySchema,
    documents: [{ _id: false, id: String, name: String, fileId: String }],
    photoFileIds: [String],
    status: { type: String, enum: ['pending', 'offered', 'documents_requested', 'cancelled'], default: 'pending', index: true },
    orderId: String,
    offerId: String,
    createdBy: String,
    documentRequests: [{ _id: false, id: String, documents: [String], deadline: String, note: String, requestedBy: String, at: Date, draft: Boolean }],
    ...timestampFields,
  },
  opts,
);
export const IntakeItem = defineModel('IntakeItem', intakeSchema, 'intake_items');

/* ───────── Firm offers ───────── */
const offerSchema = new Schema<any>(
  {
    offerId: { type: String, required: true, unique: true },
    orderId: { type: String, required: true, index: true },
    userId: { type: String, required: true },
    source: { type: String, enum: ['assay', 'intake'], default: 'assay' },
    mineral: { type: mineralSub, required: true },
    declared: quantitySchema,
    assayed: quantitySchema,
    assay: { grade: String, certificateNo: String, fileId: String },
    rateApplied: unitPriceSchema,
    suggested: moneySchema,
    amount: moneySchema,
    note: { type: String, default: '' },
    noteKind: { type: String, enum: ['clean', 'variance', 'override'], default: 'clean' },
    validityHours: { type: Number, default: 48 },
    status: { type: String, enum: ['pending', 'approved', 'adjusted', 'held', 'sent', 'expired'], default: 'pending', index: true },
    decisionReason: String,
    decidedBy: String,
    decidedAt: Date,
    sentAt: Date,
    expiresAt: Date,
    /** Staff member who prepared / priced the offer — blocked from approving it (four-eyes). */
    createdBy: String,
    ...timestampFields,
  },
  opts,
);
export const Offer = defineModel('Offer', offerSchema, 'offers');

/* ───────── Vault lots ───────── */
const lotSchema = new Schema<any>(
  {
    lotId: { type: String, required: true, unique: true },
    mineral: { type: mineralSub, required: true },
    grade: String,
    quantity: { type: quantitySchema, required: true },
    sourceOrderId: String,
    status: { type: String, enum: LOT_STATUSES, default: 'in_vault', index: true },
    location: String,
    costBasis: moneySchema,
    costRate: unitPriceSchema,
    heldSince: { type: Date, default: Date.now },
    custody: [{ _id: false, title: String, description: String, at: Date, actor: String, state: String }],
    photos: [{ _id: false, fileId: String, label: { type: String, enum: ['intake', 'seal', 'bay', 'weigh_in'] } }],
    assay: {
      certificateNo: String,
      fileId: String,
      labId: String,
      date: Date,
      grade: String,
      method: String,
      netQuantity: quantitySchema,
    },
    allocationHistory: [{ _id: false, title: String, sub: String, date: Date, amount: moneySchema }],
    hold: {
      reason: String,
      reviewOn: String,
      visibleInUnallocatedQueue: Boolean,
      heldBy: String,
      at: Date,
    },
    listingId: String,
    auctionId: String,
    passportId: String,
    ...timestampFields,
  },
  opts,
);
lotSchema.index({ status: 1, heldSince: 1 });
export const VaultLot = defineModel('VaultLot', lotSchema, 'vault_lots');

/* ───────── Catalog listings ───────── */
const listingSchema = new Schema<any>(
  {
    listingId: { type: String, required: true, unique: true },
    lotId: { type: String, required: true, index: true },
    mineral: { type: mineralSub, required: true },
    grade: String,
    quantityTotal: { type: quantitySchema, required: true },
    quantityLeft: { type: quantitySchema, required: true },
    askPrice: { type: unitPriceSchema, required: true },
    priceFloor: unitPriceSchema,
    minParcel: { kind: { type: String, enum: ['percent', 'quantity'], default: 'percent' }, value: { type: Number, default: 10 }, unit: String },
    status: { type: String, enum: LISTING_STATUSES, default: 'live', index: true },
    access: { type: String, enum: BUYER_ACCESS, default: 'all_verified' },
    views: { type: Number, default: 0 },
    enquiries: { type: Number, default: 0 },
    listedAt: Date,
    opensAt: Date,
    endedAt: Date,
    featured: { type: Boolean, default: false },
    description: { type: String, default: '' },
    showAssayToBuyers: { type: Boolean, default: true },
    sourceAuctionId: String,
    createdBy: String,
    ...timestampFields,
  },
  opts,
);
export const Listing = defineModel('Listing', listingSchema, 'listings');

/* ───────── Rates ───────── */
const rateSchema = new Schema<any>(
  {
    rateId: { type: String, required: true, unique: true },
    mineralId: String,
    mineral: { type: String, required: true },
    grade: { type: String, default: '' },
    per: { type: String, default: 'kg' },
    feedBuy: { type: unitPriceSchema, required: true },
    feedSell: { type: unitPriceSchema, required: true },
    buy: { type: unitPriceSchema, required: true },
    sell: { type: unitPriceSchema, required: true },
    source: { type: String, enum: ['market_feed', 'manual_override'], default: 'market_feed', index: true },
    feedSyncedAt: Date,
    overrideReason: String,
    overriddenBy: String,
    trend24hPct: { type: Number, default: 0 },
    ...timestampFields,
  },
  opts,
);
export const Rate = defineModel('Rate', rateSchema, 'rates');

const rateHistorySchema = new Schema<any>(
  {
    rateId: { type: String, required: true },
    at: { type: Date, required: true },
    buyMinor: { type: Number, required: true },
    sellMinor: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    scale: { type: Number, default: 2 },
    per: { type: String, default: 'kg' },
  },
  { versionKey: false },
);
rateHistorySchema.index({ rateId: 1, at: 1 });
export const RateHistory = defineModel('RateHistory', rateHistorySchema, 'rate_history');

/* ───────── Auctions ───────── */
const auctionSchema = new Schema<any>(
  {
    auctionId: { type: String, required: true, unique: true },
    status: { type: String, enum: AUCTION_STATUSES, default: 'upcoming', index: true },
    lotId: { type: String, required: true, index: true },
    mineral: { type: mineralSub, required: true },
    grade: String,
    quantity: { type: quantitySchema, required: true },
    startingBid: { type: moneySchema, required: true },
    reserve: moneySchema,
    increment: moneySchema,
    currentBid: moneySchema,
    bidCount: { type: Number, default: 0 },
    bidderIds: [String],
    leaderId: String,
    opensAt: Date,
    endsAt: Date,
    durationMs: Number,
    access: { type: String, enum: BUYER_ACCESS, default: 'all_verified' },
    flagged: { type: Boolean, default: false },
    flags: [{ _id: false, flagId: String, kind: String, note: String, bidIds: [String], by: String, at: Date }],
    outcome: { type: String, enum: ['reserve_met', 'reserve_not_met', 'cancelled'] },
    finalBid: moneySchema,
    winnerId: String,
    pausedAt: Date,
    costBasis: moneySchema,
    realisable: moneySchema,
    riskSignal: { kind: String, text: String, detectedAt: Date },
    resolution: {
      closedAt: Date,
      marginOverCostPct: Number,
      buyOrderId: String,
      pipelineStage: String,
      escrowRef: String,
    },
    cancelReason: String,
    sourceListingId: String,
    relistedFrom: String,
    /** Set once #66 has been used on an ended/cancelled auction (a lot can only be relisted once per auction). */
    relisted: { action: String, at: Date, refId: String, by: String },
    createdBy: String,
    ...timestampFields,
  },
  opts,
);
auctionSchema.index({ status: 1, endsAt: 1 });
export const Auction = defineModel('Auction', auctionSchema, 'auctions');

const bidSchema = new Schema<any>(
  {
    bidId: { type: String, required: true, unique: true },
    auctionId: { type: String, required: true },
    amount: { type: moneySchema, required: true },
    bidderId: { type: String, required: true },
    at: { type: Date, default: Date.now },
    linkedAccount: { type: Boolean, default: false },
    meta: { type: String, default: '' },
  },
  { versionKey: false },
);
bidSchema.index({ auctionId: 1, at: -1 });
export const Bid = defineModel('Bid', bidSchema, 'bids');

/** Persisted SSE events: lets /bids/stream replay for Last-Event-ID (10 min) and work across instances. */
const auctionEventSchema = new Schema<any>(
  {
    seq: { type: Number, required: true },
    auctionId: { type: String, required: true },
    type: { type: String, enum: ['bid', 'state', 'risk'], required: true },
    data: Schema.Types.Mixed,
    createdAt: { type: Date, default: Date.now, expires: 3600 },
  },
  { versionKey: false },
);
auctionEventSchema.index({ auctionId: 1, seq: 1 });
export const AuctionEvent = defineModel('AuctionEvent', auctionEventSchema, 'auction_events');

/* ───────── Settlements ───────── */
const settlementSchema = new Schema<any>(
  {
    settlementId: { type: String, required: true, unique: true },
    date: { type: Date, default: Date.now, index: true },
    ref: { type: refSchema, required: true },
    partyId: String,
    kind: { type: String, enum: SETTLEMENT_KINDS, required: true },
    amount: { type: moneySchema, required: true },
    usdEquivalent: moneySchema,
    feeAmount: moneySchema,
    status: { type: String, enum: SETTLEMENT_STATUSES, default: 'pending', index: true },
    rail: { type: String, enum: ['bank', 'mpesa', 'lightning', 'on_chain'] },
    escrowRef: String,
    createdBy: String,
    ...timestampFields,
  },
  opts,
);
export const Settlement = defineModel('Settlement', settlementSchema, 'settlements');
