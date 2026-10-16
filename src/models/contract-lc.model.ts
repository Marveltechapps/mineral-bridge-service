import type { MoneyDoc } from './_shared.js';
import { defineModel, pk, SubDocId } from './_shared.js';

export interface IChainAnchor {
  hash: string;
  network: string;
  blockNumber: number | null;
  anchoredAt: Date | null;
}

export type ContractStatus = 'draft' | 'signed' | 'countersigned' | 'cancelled';
export type LcType = 'Irrevocable' | 'Confirmed' | 'Standby';
export type Tenor = 'At sight' | '30 days' | '60 days' | '90 days';

export interface IContract {
  _id: string;
  reference: string;
  status: ContractStatus;
  negotiationId: string;
  acceptedOfferId: string;
  lcId?: string;
  buyerId: string;
  sellerId: string;
  signatories: { buyer?: string; seller?: string };
  terms: {
    lotDescription: string;
    incoterm: string;
    namedPort: string;
    unitPrice: MoneyDoc;
    quantity: number;
    unit: string;
    total: MoneyDoc;
    shipmentFrom: string;
    shipmentTo: string;
    lcType: LcType;
    tenor: Tenor;
    issuingBankId: string;
    issuingBankName: string;
    presentationPeriodDays: number;
  };
  signatures: { buyer?: { signatory: string; signedAt: Date }; seller?: { signatory: string; signedAt: Date } };
  termsHash?: string;
  liveKey?: string;
  anchor?: IChainAnchor;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const ContractModel = defineModel<IContract>(
  'Contract',
  {
    _id: pk('ctr'),
    reference: { type: String, required: true, unique: true },
    status: { type: String, enum: ['draft', 'signed', 'countersigned', 'cancelled'], default: 'draft' },
    negotiationId: { type: String, required: true },
    acceptedOfferId: { type: String, required: true },
    lcId: String,
    buyerId: { type: String, required: true },
    sellerId: { type: String, required: true },
    signatories: { type: Object, default: {} },
    terms: { type: Object, required: true },
    signatures: { type: Object, default: {} },
    termsHash: String,
    /** negotiationId while the contract is live; unset on cancel. Unique-sparse => one live contract per negotiation. */
    liveKey: { type: String, unique: true, sparse: true },
    anchor: { type: Object },
    version: { type: Number, default: 0 },
  },
  {
    indexes: [
      [{ negotiationId: 1 }],
      [{ buyerId: 1 }],
      [{ sellerId: 1 }],
    ],
    schema: { minimize: false },
  },
);

export type LcStatus = 'Applied' | 'Issued' | 'Advised' | 'Confirmed' | 'Presented' | 'Examined' | 'Paid' | 'Refused' | 'Expired';
export type LcDocKey = 'invoice' | 'bl' | 'packing' | 'origin' | 'assay' | 'insurance' | 'inspection';

export interface IDiscrepancy {
  code: string;
  documentKey: string | null;
  message: string;
  severity: 'discrepancy' | 'warning';
}

export interface ILetterOfCredit {
  _id: string;
  reference: string;
  status: LcStatus;
  lcType: LcType;
  tenor: Tenor;
  amount: MoneyDoc;
  contractId: string;
  applicantId: string;
  beneficiaryId: string;
  issuingBank: { id: string; name: string; swift: string };
  advisingBank?: { id: string; name: string; swift: string };
  goodsDescription: string;
  incoterm: string;
  namedPort: string;
  latestShipmentDate: string;
  expiresAt: Date;
  presentationPeriodDays: number;
  billOfLading?: { onBoardDate?: string; number?: string; vessel?: string };
  documents: {
    key: LcDocKey;
    fileId: string;
    uploadedAt: Date;
    extracted?: Record<string, string>;
  }[];
  precheck?: { checkedAt: Date; compliant: boolean; discrepancies: IDiscrepancy[]; docsFingerprint: string };
  presentation?: {
    presentedAt: Date;
    notes?: string;
    examination?: 'accepted' | 'refused';
    examinedAt?: Date;
    discrepancies: IDiscrepancy[];
    examinerNotes?: string;
  };
  payment?: { releasedAt: Date; amount: MoneyDoc; reference?: string; anchor: IChainAnchor };
  milestones: { key: string; at: Date }[];
  amendments: { _id: string; status: string; changes: { field: string; from: string; to: string }[]; reason: string; requestedAt: Date; approvals: { party: string; approved: boolean | null }[] }[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const LetterOfCreditModel = defineModel<ILetterOfCredit>(
  'LetterOfCredit',
  {
    _id: pk('lc'),
    reference: { type: String, required: true, unique: true },
    status: {
      type: String,
      enum: ['Applied', 'Issued', 'Advised', 'Confirmed', 'Presented', 'Examined', 'Paid', 'Refused', 'Expired'],
      default: 'Applied',
    },
    lcType: String,
    tenor: String,
    amount: { type: Object, required: true },
    contractId: { type: String, required: true, unique: true },
    applicantId: { type: String, required: true },
    beneficiaryId: { type: String, required: true },
    issuingBank: { type: Object, required: true },
    advisingBank: { type: Object },
    goodsDescription: String,
    incoterm: String,
    namedPort: String,
    latestShipmentDate: String,
    expiresAt: { type: Date, required: true },
    presentationPeriodDays: { type: Number, default: 21 },
    billOfLading: { type: Object },
    documents: [{ _id: false, key: String, fileId: String, uploadedAt: Date, extracted: Object }],
    precheck: { type: Object },
    presentation: { type: Object },
    payment: { type: Object },
    milestones: [{ _id: false, key: String, at: Date }],
    amendments: [
      {
        _id: SubDocId('amd'),
        status: String,
        changes: [{ _id: false, field: String, from: String, to: String }],
        reason: String,
        requestedAt: Date,
        approvals: [{ _id: false, party: String, approved: Boolean }],
      },
    ],
    version: { type: Number, default: 0 },
  },
  { indexes: [[{ applicantId: 1 }], [{ beneficiaryId: 1 }], [{ status: 1 }]], schema: { minimize: false } },
);

export type ShipmentStatus = 'booked' | 'loaded' | 'in_transit' | 'discharged' | 'delivered' | 'delayed';

export interface IShipment {
  _id: string;
  reference: string;
  ownerIds: string[];
  lotDescription: string;
  billOfLading: string;
  lcId?: string;
  orderId?: string;
  contractId?: string;
  route: { fromPort: string; fromCountry: string; toPort: string; toCountry: string };
  departedAt?: Date;
  estimatedArrival: Date;
  actualArrival?: Date;
  progressPercent: number;
  vessel: { name: string; voyage: string; imo?: string };
  container: { number: string; sealNumber: string; type: string };
  insuredValue: MoneyDoc;
  insuranceRate: number;
  incoterm: string;
  status: ShipmentStatus;
  events: { _id: string; index: number; title: string; actor?: string; location?: string; occurredAt?: Date; projected: boolean; anchor?: IChainAnchor }[];
  documents: { _id: string; kind: string; name: string; fileId?: string }[];
  createdAt: Date;
}

export const ShipmentModel = defineModel<IShipment>(
  'Shipment',
  {
    _id: pk('shp'),
    reference: { type: String, required: true, unique: true },
    ownerIds: { type: [String], index: true },
    lotDescription: String,
    billOfLading: String,
    lcId: String,
    orderId: String,
    contractId: String,
    route: { type: Object, required: true },
    departedAt: Date,
    estimatedArrival: { type: Date, required: true },
    actualArrival: Date,
    progressPercent: { type: Number, default: 0 },
    vessel: { type: Object },
    container: { type: Object },
    insuredValue: { type: Object },
    insuranceRate: { type: Number, default: 1.1 },
    incoterm: String,
    status: { type: String, enum: ['booked', 'loaded', 'in_transit', 'discharged', 'delivered', 'delayed'], default: 'booked' },
    events: [
      {
        _id: SubDocId('sev'),
        index: Number,
        title: String,
        actor: String,
        location: String,
        occurredAt: Date,
        projected: { type: Boolean, default: false },
        anchor: Object,
      },
    ],
    documents: [{ _id: SubDocId('doc'), kind: String, name: String, fileId: String }],
  },
  { indexes: [[{ lcId: 1 }], [{ orderId: 1 }], [{ contractId: 1 }]], schema: { minimize: false } },
);

/** Binds a `bank_operator` user to the issuing banks whose LCs they may work. Unassigned operators see nothing. */
export interface IBankOperator {
  _id: string;
  userId: string;
  bankIds: string[];
  createdAt: Date;
}

export const BankOperatorModel = defineModel<IBankOperator>('BankOperator', {
  _id: pk('bop'),
  userId: { type: String, required: true, unique: true },
  bankIds: { type: [String], default: [] },
});
