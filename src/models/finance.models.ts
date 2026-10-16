import { Schema } from 'mongoose';
import { defineModel, timestampFields } from '../common/db/define-model.js';
import { CHAIN_EVENT_TYPES, LC_STAGES, NEGOTIATION_STATUSES } from '../modules/admin/shared/enums.js';
import { moneySchema, quantitySchema, refSchema, unitPriceSchema } from './shared.js';

const opts = { timestamps: true } as const;

/* ───────── Letters of credit ───────── */
const lcSchema = new Schema<any>(
  {
    lcId: { type: String, required: true, unique: true },
    applicantId: { type: String, required: true },
    beneficiaryId: { type: String, required: true },
    goods: String,
    amount: { type: moneySchema, required: true },
    bankId: String,
    bankName: String,
    status: { type: String, enum: LC_STAGES, default: 'requested', index: true },
    expiry: Date,
    latestShipmentDate: Date,
    orderId: String,
    contractId: { type: String, index: true },
    documents: [{ _id: false, name: String, status: { type: String, enum: ['received', 'pending', 'discrepant'], default: 'pending' }, fileId: String }],
    discrepancies: [
      {
        _id: false,
        id: String,
        text: String,
        raisedAt: Date,
        status: { type: String, enum: ['open', 'resolved'], default: 'open' },
        resolvedBy: String,
        resolvedAt: Date,
        resolution: String,
        note: String,
        fileId: String,
      },
    ],
    amendments: [
      {
        _id: false,
        id: String,
        type: { type: String },
        newValue: String,
        reason: String,
        status: { type: String, enum: ['requested', 'accepted', 'rejected'], default: 'requested' },
        requestedAt: Date,
        requestedBy: String,
        draft: { type: Boolean, default: false },
      },
    ],
    stageHistory: [{ _id: false, stage: String, at: Date }],
    paidAt: Date,
    settlementId: String,
    /** Denormalised count of open discrepancies (sortable / filterable). */
    openDiscrepancyCount: { type: Number, default: 0, index: true },
    draft: { type: Boolean, default: false },
    /** Staff who requested the LC — blocked from releasing it (four-eyes). */
    createdBy: String,
    ...timestampFields,
  },
  opts,
);
lcSchema.index({ expiry: 1 });
export const LetterOfCredit = defineModel('LetterOfCredit', lcSchema, 'letters_of_credit');

/* ───────── Negotiations & contracts ───────── */
const negotiationSchema = new Schema<any>(
  {
    negotiationId: { type: String, required: true, unique: true },
    minerId: { type: String, required: true },
    traderId: { type: String, required: true },
    goods: String,
    quantity: { type: quantitySchema, required: true },
    ask: { type: unitPriceSchema, required: true },
    offer: { type: unitPriceSchema, required: true },
    rounds: { type: Number, default: 1 },
    status: { type: String, enum: NEGOTIATION_STATUSES, default: 'awaiting_trader', index: true },
    lastActivityAt: { type: Date, default: Date.now },
    openedAt: { type: Date, default: Date.now },
    agreedAt: Date,
    history: [{ _id: false, round: Number, side: { type: String, enum: ['miner', 'trader'] }, price: unitPriceSchema, at: Date }],
    mediations: [{ _id: false, price: unitPriceSchema, validForHours: Number, note: String, by: String, at: Date, draft: { type: Boolean, default: false } }],
    reminders: [{ _id: false, to: String, by: String, at: Date }],
    agreedPrice: unitPriceSchema,
    contractId: String,
    ...timestampFields,
  },
  opts,
);
export const Negotiation = defineModel('Negotiation', negotiationSchema, 'negotiations');

const contractSchema = new Schema<any>(
  {
    contractId: { type: String, required: true, unique: true },
    sellerId: String,
    buyerId: String,
    goods: String,
    value: moneySchema,
    status: { type: String, enum: ['draft', 'pending_signature', 'signed'], default: 'pending_signature', index: true },
    signedAt: Date,
    lcId: String,
    requireLc: { type: Boolean, default: true },
    negotiationId: String,
    orderId: String,
    templateId: String,
    signature: { provider: String, envelopeId: String, status: String },
    createdBy: String,
    ...timestampFields,
  },
  opts,
);
export const Contract = defineModel('Contract', contractSchema, 'contracts');

/* ───────── Chain: passports, anchors, events ───────── */
const passportSchema = new Schema<any>(
  {
    passportId: { type: String, required: true, unique: true },
    lotId: String,
    orderId: String,
    hash: { type: String, required: true, index: true },
    mintedAt: { type: Date, default: Date.now },
    anchorId: String,
    custodyEvents: { type: Number, default: 1 },
  },
  { versionKey: false },
);
export const Passport = defineModel('Passport', passportSchema, 'passports');

const anchorSchema = new Schema<any>(
  {
    anchorId: { type: String, required: true, unique: true },
    status: { type: String, enum: ['queued', 'broadcast', 'confirmed', 'failed'], default: 'queued', index: true },
    block: Number,
    confirmations: { type: Number, default: 0 },
    at: Date,
    merkleRoot: String,
    txId: String,
    explorerUrl: String,
    batch: { passports: { type: Number, default: 0 }, custodyEvents: { type: Number, default: 0 } },
    closesAt: Date,
    manual: { type: Boolean, default: false },
    reason: String,
    requestedBy: String,
    ...timestampFields,
  },
  opts,
);
export const Anchor = defineModel('Anchor', anchorSchema, 'anchors');

const chainEventSchema = new Schema<any>(
  {
    eventId: { type: String, required: true, unique: true },
    type: { type: String, enum: CHAIN_EVENT_TYPES, required: true, index: true },
    ref: { type: refSchema, required: true },
    description: String,
    txHash: String,
    at: { type: Date, default: Date.now, index: true },
    status: { type: String, enum: ['confirmed', 'pending'], default: 'pending' },
    anchorId: String,
  },
  { versionKey: false },
);
export const ChainEvent = defineModel('ChainEvent', chainEventSchema, 'chain_events');
