import { defineModel, pk } from './_shared.js';

export type ReferenceKind =
  | 'category'
  | 'mineral'
  | 'unit'
  | 'country'
  | 'incoterm'
  | 'id-type'
  | 'bank'
  | 'payout-network'
  | 'support-channel'
  | 'faq';

export interface IReferenceItem {
  _id: string;
  kind: ReferenceKind;
  code: string;
  name: string;
  sort: number;
  active: boolean;
  /** Free-form per-kind payload (e.g. country dial code, unit factor, bank swift). */
  data: Record<string, unknown>;
}

export const ReferenceModel = defineModel<IReferenceItem>(
  'ReferenceItem',
  {
    _id: pk('ref'),
    kind: { type: String, required: true },
    code: { type: String, required: true },
    name: { type: String, required: true },
    sort: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    data: { type: Object, default: {} },
  },
  { indexes: [[{ kind: 1, code: 1 }, { unique: true }]], schema: { minimize: false } },
);

export interface IContentBlock {
  _id: string; // key, e.g. "intro", "account-tiers", "faq"
  data: unknown;
  locale: string;
  version: number;
}

export const ContentModel = defineModel<IContentBlock>(
  'ContentBlock',
  {
    _id: { type: String },
    data: { type: Object, default: {} },
    locale: { type: String, default: 'en' },
    version: { type: Number, default: 1 },
  },
  { schema: { minimize: false } },
);

export interface IRateSnapshot {
  _id: string;
  mineralCode: string;
  currency: string;
  /** minor units x 10^4 per gram (see pricing-math.ts) */
  unitPriceMinorE4PerGram: number;
  change24hBps: number;
  asOf: Date;
  source: string;
}

export const RateModel = defineModel<IRateSnapshot>(
  'RateSnapshot',
  {
    _id: pk('rte'),
    mineralCode: { type: String, required: true },
    currency: { type: String, default: 'USD' },
    unitPriceMinorE4PerGram: { type: Number, required: true },
    change24hBps: { type: Number, default: 0 },
    asOf: { type: Date, required: true },
    source: { type: String, default: 'desk' },
  },
  { indexes: [[{ mineralCode: 1, asOf: -1 }]] },
);
