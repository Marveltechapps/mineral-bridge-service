import type { ReferenceKind } from '../../models/reference.model.js';

type Item = { code: string; name: string; data?: Record<string, unknown> };

/** Built-in reference data used until an admin populates the ReferenceItem collection for a kind. */
export const REFERENCE_DEFAULTS: Record<ReferenceKind, Item[]> = {
  category: [
    { code: 'precious-metals', name: 'Precious metals' },
    { code: 'gemstones', name: 'Gemstones' },
    { code: 'industrial', name: 'Industrial minerals' },
    { code: 'energy', name: 'Energy minerals' },
  ],
  mineral: [
    { code: 'AU', name: 'Gold', data: { category: 'precious-metals' } },
    { code: 'AG', name: 'Silver', data: { category: 'precious-metals' } },
    { code: 'PT', name: 'Platinum', data: { category: 'precious-metals' } },
    { code: 'CU', name: 'Copper', data: { category: 'industrial' } },
    { code: 'LI', name: 'Lithium', data: { category: 'energy' } },
    { code: 'CO', name: 'Cobalt', data: { category: 'energy' } },
    { code: 'DIA', name: 'Diamond', data: { category: 'gemstones' } },
  ],
  unit: [
    { code: 'g', name: 'Gram', data: { grams: 1 } },
    { code: 'kg', name: 'Kilogram', data: { grams: 1000 } },
    { code: 'oz', name: 'Troy ounce', data: { grams: 31.1034768 } },
    { code: 'ct', name: 'Carat', data: { grams: 0.2 } },
    { code: 'MT', name: 'Metric tonne', data: { grams: 1_000_000 } },
  ],
  country: [
    { code: 'NG', name: 'Nigeria', data: { dial: '+234' } },
    { code: 'GH', name: 'Ghana', data: { dial: '+233' } },
    { code: 'KE', name: 'Kenya', data: { dial: '+254' } },
    { code: 'TZ', name: 'Tanzania', data: { dial: '+255' } },
    { code: 'ZA', name: 'South Africa', data: { dial: '+27' } },
    { code: 'AE', name: 'United Arab Emirates', data: { dial: '+971' } },
    { code: 'GB', name: 'United Kingdom', data: { dial: '+44' } },
    { code: 'US', name: 'United States', data: { dial: '+1' } },
  ],
  incoterm: [
    { code: 'EXW', name: 'Ex Works' },
    { code: 'FCA', name: 'Free Carrier' },
    { code: 'FOB', name: 'Free On Board' },
    { code: 'CFR', name: 'Cost and Freight' },
    { code: 'CIF', name: 'Cost, Insurance and Freight' },
    { code: 'DAP', name: 'Delivered At Place' },
    { code: 'DDP', name: 'Delivered Duty Paid' },
  ],
  'id-type': [
    { code: 'national_id', name: 'National ID', data: { countries: ['NG', 'GH', 'KE'] } },
    { code: 'passport', name: 'International passport' },
    { code: 'drivers_licence', name: "Driver's licence" },
    { code: 'voters_card', name: "Voter's card", data: { countries: ['NG', 'GH'] } },
  ],
  bank: [
    { code: '044', name: 'Access Bank', data: { country: 'NG', swift: 'ABNGNGLA' } },
    { code: '058', name: 'Guaranty Trust Bank', data: { country: 'NG', swift: 'GTBINGLA' } },
    { code: '011', name: 'First Bank of Nigeria', data: { country: 'NG', swift: 'FBNINGLA' } },
    { code: 'GCB', name: 'GCB Bank', data: { country: 'GH', swift: 'GHCBGHAC' } },
  ],
  'payout-network': [
    { code: 'bank', name: 'Bank transfer' },
    { code: 'mtn', name: 'MTN MoMo', data: { kind: 'mobile_money' } },
    { code: 'airtel', name: 'Airtel Money', data: { kind: 'mobile_money' } },
    { code: 'btc', name: 'Bitcoin', data: { kind: 'btc' } },
  ],
  'support-channel': [
    { code: 'chat', name: 'Live chat', data: { hours: '08:00-20:00 WAT' } },
    { code: 'callback', name: 'Request a call back', data: { hours: '08:00-18:00 WAT' } },
    { code: 'email', name: 'Email support', data: { address: 'support@mineralbridge.com' } },
  ],
  faq: [
    { code: 'escrow', name: 'How does escrow work?', data: { answer: 'Funds are held by Mineral Bridge until you confirm delivery and assay.' } },
    { code: 'kyc', name: 'Why do I need to verify my identity?', data: { answer: 'We are required to know who trades on the platform before any money moves.' } },
    { code: 'fees', name: 'What are the fees?', data: { answer: 'Buying carries a small platform fee; selling a 2% fee. Fees are shown before you confirm.' } },
  ],
};

export const CONTENT_DEFAULTS: Record<string, unknown> = {
  intro: {
    slides: [
      { title: 'Trade verified minerals', body: 'Buy and sell with traceable provenance and escrow protection.' },
      { title: 'Sell with confidence', body: 'Book an evaluation, get an offer, and be paid securely.' },
      { title: 'Learn the market', body: 'Short lessons on assaying, grading and logistics.' },
    ],
  },
  'account-tiers': {
    tiers: [
      { id: 1, tag: 'TIER 1', name: 'Individual', limits: { perOrderUsd: 50_000 }, requirements: ['Government ID', 'Selfie'] },
      { id: 2, tag: 'TIER 2', name: 'Small group / SME', limits: { perOrderUsd: 250_000 }, requirements: ['Government ID', 'Proof of address', 'Group registration'] },
      { id: 3, tag: 'TIER 3', name: 'Registered company', limits: { perOrderUsd: null }, requirements: ['Certificate of incorporation', 'Directors ID', 'Import permit'] },
    ],
  },
};

/** Indicative desk rates (minor units x 1e4 per gram, USD) used until real snapshots exist. */
export const RATE_DEFAULTS = [
  { mineralCode: 'AU', unitPriceMinorE4PerGram: 780_000_000, change24hBps: 35 },
  { mineralCode: 'AG', unitPriceMinorE4PerGram: 9_400_000, change24hBps: -12 },
  { mineralCode: 'PT', unitPriceMinorE4PerGram: 310_000_000, change24hBps: 8 },
  { mineralCode: 'CU', unitPriceMinorE4PerGram: 95_000, change24hBps: 20 },
];
