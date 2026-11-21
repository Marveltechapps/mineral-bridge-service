import type { MoneyDoc } from './_shared.js';
import { defineModel, pk, SubDocId } from './_shared.js';

/* ───────────────────────────── Listings (web sell intake) ───────────────────────────── */

export type ListingStatus =
  | 'draft'
  | 'submitted'
  | 'visit_scheduled'
  | 'verified'
  | 'in_transit'
  | 'received'
  | 'paid'
  | 'rejected';

export interface IListing {
  _id: string;
  reference: string;
  userId: string;
  mineralId?: string | null;
  mineralName: string;
  customMineralName?: string | null;
  categoryKey: string;
  grams: number;
  form: 'raw' | 'semi_finished' | 'finished';
  verificationAddress: { city: string; region?: string; country: string; countryName?: string; streetAddress?: string };
  preferredSlot: 'morning' | 'afternoon' | 'flexible';
  payoutMethodId?: string | null;
  payoutPreference?: string;
  photos: { _id: string; fileId: string; addedAt: Date }[];
  status: ListingStatus;
  indicativeNet?: MoneyDoc;
  quoteSnapshot?: { gross: MoneyDoc; fee: MoneyDoc; net: MoneyDoc; feeBps: number };
  /** True once the desk has entered the price agreed with the seller. */
  priceConfirmed?: boolean;
  submittedAt?: Date;
  visitScheduledFor?: Date;
  verification?: { agent?: { name: string; contact: string }; completedAt?: Date; findings?: string; assay?: { grade: string; method: string; laboratory: string }; result?: 'completed' | 'failed' };
  orderId?: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const ListingModel = defineModel<IListing>(
  'Listing',
  {
    _id: pk('lst'),
    reference: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    mineralId: String,
    mineralName: { type: String, required: true },
    customMineralName: String,
    categoryKey: { type: String, required: true },
    grams: { type: Number, required: true },
    form: { type: String, enum: ['raw', 'semi_finished', 'finished'], default: 'raw' },
    verificationAddress: { type: Object, required: true },
    preferredSlot: { type: String, enum: ['morning', 'afternoon', 'flexible'], default: 'flexible' },
    payoutMethodId: String,
    payoutPreference: String,
    photos: [{ _id: SubDocId('pho'), fileId: String, addedAt: { type: Date, default: Date.now } }],
    status: {
      type: String,
      enum: ['draft', 'submitted', 'visit_scheduled', 'verified', 'in_transit', 'received', 'paid', 'rejected'],
      default: 'draft',
    },
    indicativeNet: { type: Object },
    quoteSnapshot: { type: Object },
    priceConfirmed: { type: Boolean, default: false },
    submittedAt: Date,
    visitScheduledFor: Date,
    verification: { type: Object },
    orderId: String,
    version: { type: Number, default: 0 },
  },
  { indexes: [[{ userId: 1, createdAt: -1 }]], schema: { minimize: false } },
);

/* ───────────────────────────── Passports ───────────────────────────── */

export interface IPassport {
  _id: string;
  lotId?: string;
  mineral: string;
  origin: { country: string; region?: string; site?: string };
  grams: number;
  purity?: string;
  custody: string;
  anchorHash: string;
  createdAt: Date;
}

export const PassportModel = defineModel<IPassport>('Passport', {
  _id: pk('psp'),
  lotId: { type: String, index: true },
  mineral: { type: String, required: true },
  origin: { type: Object, required: true },
  grams: Number,
  purity: String,
  custody: { type: String, default: 'Mineral Bridge vault' },
  anchorHash: { type: String, required: true },
});

export interface IPassportEvent {
  _id: string;
  passportId: string;
  index: number;
  title: string;
  actor?: string;
  location?: string;
  occurredAt: Date;
  anchor?: { hash: string; network: string; blockNumber: number | null; anchoredAt: Date | null };
}

export const PassportEventModel = defineModel<IPassportEvent>(
  'PassportEvent',
  {
    _id: pk('pev'),
    passportId: { type: String, required: true },
    index: Number,
    title: String,
    actor: String,
    location: String,
    occurredAt: Date,
    anchor: { type: Object },
  },
  { indexes: [[{ passportId: 1, index: 1 }]] },
);

/* ───────────────────────────── ASM registrations ───────────────────────────── */

export type AsmStatus = 'draft' | 'submitted' | 'visit_scheduled' | 'approved' | 'rejected';
export type AsmStep = 'elig' | 'site' | 'gps' | 'docs' | 'done';
export type AsmDocKey = 'id' | 'licence' | 'photos';

export interface IAsmRegistration {
  _id: string;
  reference?: string;
  userId: string;
  status: AsmStatus;
  step: AsmStep;
  eligibilityAnswers: { index: number; answer: boolean }[];
  eligibilityMet: boolean;
  site: { name?: string; country?: string; region?: string; minerals: string[]; workerCount: number };
  gps?: { latitude: number; longitude: number; accuracyMetres?: number; capturedAt: Date };
  gpsRegion?: string;
  documents: { key: AsmDocKey; fileIds: string[]; status: 'missing' | 'uploaded' | 'under_review' | 'accepted' | 'rejected'; rejectionReason?: string }[];
  submittedAt?: Date;
  visitScheduledFor?: Date;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const AsmRegistrationModel = defineModel<IAsmRegistration>(
  'AsmRegistration',
  {
    _id: pk('asm'),
    reference: { type: String, sparse: true, unique: true },
    userId: { type: String, required: true, index: true },
    status: { type: String, enum: ['draft', 'submitted', 'visit_scheduled', 'approved', 'rejected'], default: 'draft' },
    step: { type: String, enum: ['elig', 'site', 'gps', 'docs', 'done'], default: 'elig' },
    eligibilityAnswers: [{ _id: false, index: Number, answer: Boolean }],
    eligibilityMet: { type: Boolean, default: false },
    site: {
      name: String,
      country: String,
      region: String,
      minerals: { type: [String], default: [] },
      workerCount: { type: Number, default: 0 },
    },
    gps: { latitude: Number, longitude: Number, accuracyMetres: Number, capturedAt: Date },
    gpsRegion: String,
    documents: [
      {
        _id: false,
        key: { type: String, enum: ['id', 'licence', 'photos'] },
        fileIds: [String],
        status: { type: String, default: 'missing' },
        rejectionReason: String,
      },
    ],
    submittedAt: Date,
    visitScheduledFor: Date,
    version: { type: Number, default: 0 },
  },
);

/* ───────────────────────────── Negotiations ───────────────────────────── */

export type OfferState = 'open' | 'accepted' | 'countered' | 'rejected' | 'expired' | 'superseded';

export interface INegotiationOffer {
  _id: string;
  authorId: string;
  price: MoneyDoc; // per `unit`
  unit: string;
  quantity: number;
  incoterm: string;
  namedPort: string;
  shipmentFrom: string;
  shipmentTo: string;
  total: MoneyDoc;
  state: OfferState;
  inResponseTo?: string;
  expiresAt?: Date;
  createdAt: Date;
}

export interface INegotiation {
  _id: string;
  reference: string;
  orderId?: string;
  counterparty?: 'platform' | 'user';
  lotId?: string;
  lotName?: string;
  lotSummary?: string;
  lotGrade?: string;
  buyerId: string;
  sellerId?: string;
  status: 'awaiting_reply' | 'offer_received' | 'agreed' | 'closed';
  offers: INegotiationOffer[];
  agreedOfferId?: string;
  contractId?: string;
  lcId?: string;
  lastMessageAt: Date;
  lastMessagePreview: string;
  unread: Record<string, number>;
  lastOfferAuthorId?: string;
  /** lotId:buyerId while the negotiation is live; unset on close. Unique-sparse => one live negotiation per buyer+lot. */
  openKey?: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const NegotiationModel = defineModel<INegotiation>(
  'Negotiation',
  {
    _id: pk('neg'),
    reference: { type: String, required: true, unique: true },
    orderId: String,
    counterparty: { type: String, enum: ['platform', 'user'], default: 'user' },
    lotId: String,
    lotName: String,
    lotSummary: String,
    lotGrade: String,
    buyerId: { type: String, required: true },
    sellerId: String,
    status: { type: String, enum: ['awaiting_reply', 'offer_received', 'agreed', 'closed'], default: 'awaiting_reply' },
    offers: [
      {
        _id: SubDocId('off'),
        authorId: String,
        price: Object,
        unit: String,
        quantity: Number,
        incoterm: String,
        namedPort: String,
        shipmentFrom: String,
        shipmentTo: String,
        total: Object,
        state: { type: String, default: 'open' },
        inResponseTo: String,
        expiresAt: Date,
        createdAt: { type: Date, default: Date.now },
      },
    ],
    agreedOfferId: String,
    contractId: String,
    lcId: String,
    lastMessageAt: { type: Date, default: Date.now },
    lastMessagePreview: { type: String, default: '' },
    unread: { type: Object, default: {} },
    lastOfferAuthorId: String,
    openKey: { type: String, unique: true, sparse: true },
    version: { type: Number, default: 0 },
  },
  {
    indexes: [
      [{ buyerId: 1, updatedAt: -1 }],
      [{ sellerId: 1, updatedAt: -1 }],
      [{ orderId: 1 }, { unique: true, sparse: true }],
    ],
    schema: { minimize: false },
  },
);

export interface INegotiationMessage {
  _id: string;
  negotiationId: string;
  kind: 'text' | 'offer' | 'system';
  authorId?: string;
  body?: string;
  offerId?: string;
  event?: string;
  createdAt: Date;
}

export const NegotiationMessageModel = defineModel<INegotiationMessage>(
  'NegotiationMessage',
  {
    _id: pk('nmg'),
    negotiationId: { type: String, required: true },
    kind: { type: String, enum: ['text', 'offer', 'system'], required: true },
    authorId: String,
    body: String,
    offerId: String,
    event: String,
  },
  { indexes: [[{ negotiationId: 1, createdAt: 1 }]] },
);
