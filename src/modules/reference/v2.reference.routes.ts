import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { SettingsDoc } from '../../models/platform.models.js';
import { KYC_ID_TYPES } from '../kyc/kyc.id-types.js';
import { optionalUser } from '../auth/auth.middleware.js';

const LISTS: Record<string, unknown> = {
  countries: [
    { name: 'Nigeria', code: 'NG', dialCode: '+234', flag: '🇳🇬' },
    { name: 'Kenya', code: 'KE', dialCode: '+254', flag: '🇰🇪' },
    { name: 'Ghana', code: 'GH', dialCode: '+233', flag: '🇬🇭' },
    { name: 'South Africa', code: 'ZA', dialCode: '+27', flag: '🇿🇦' },
    { name: 'United Arab Emirates', code: 'AE', dialCode: '+971', flag: '🇦🇪' },
  ],
  'country-codes': ['NG', 'KE', 'GH', 'ZA', 'AE', 'GB', 'US'],
  'buyer-types': ['refinery', 'house', 'industry', 'jewel', 'investor', 'wholesale'],
  'seller-types': ['asm', 'industrial', 'coop', 'dealer', 'exporter', 'scrap'],
  'id-types': KYC_ID_TYPES.map((t) => ({
    id: t.id,
    wire:
      t.id === 'nin'
        ? 'national_id'
        : t.id === 'drivers_licence'
          ? 'driving_licence'
          : t.id === 'voters_card'
            ? 'voter_card'
            : t.id,
    name: t.name,
  })),
  'payment-methods': [
    { id: 'bank_transfer', label: 'Bank transfer', enabled: true },
    { id: 'upi', label: 'UPI', enabled: true },
    { id: 'net_banking', label: 'Net banking', enabled: true },
    { id: 'btc', label: 'Bitcoin', enabled: Boolean(process.env.BTC_RECEIVING_ADDRESS) },
    { id: 'lc', label: 'Letter of credit', enabled: true },
  ],
  'payout-methods': ['bank_transfer', 'upi', 'btc'],
  'payment-terms': ['advance_100', 'advance_30_70', 'lc_at_sight'],
  'payment-instructions': {
    beneficiary: process.env.PAYMENT_BENEFICIARY ?? 'Mineral Bridge Ltd',
    bank: process.env.PAYMENT_BANK ?? 'Example Bank',
    account: process.env.PAYMENT_ACCOUNT ?? '0000000000',
    swift: process.env.PAYMENT_SWIFT ?? 'EXAMPLEXXX',
    upiId: process.env.PAYMENT_UPI ?? null,
  },
  'refund-reasons': [
    'delivery_delayed',
    'quantity_quality',
    'damaged_in_transit',
    'paid_twice',
    'no_longer_needed',
    'other',
  ],
  'cancel-reasons-buy': ['Changed my mind', 'Found another supplier', 'Delivery timeline too long', 'Other'],
  'cancel-reasons-sell': ['Changed my mind', 'Material no longer available', 'Other'],
  units: ['g', 'kg', 't', 'ct', 'oz'],
  'inspection-slots': ['09:00', '11:00', '14:00', '16:00'],
  'sell-forms': ['Raw', 'Semi-finished', 'Finished'],
  'sell-document-types': ['assay', 'origin', 'export_permit', 'other'],
};

export function createV2ReferenceRouter(): Router {
  const r = Router();
  r.get(
    '/:list',
    optionalUser,
    asyncHandler(async (req, res) => {
      const list = String(req.params.list);
      if (list === 'payment-methods' || list === 'payment-instructions') {
        const stored = await SettingsDoc.findOne({ key: 'platform' }).lean();
        const values = (stored?.values ?? {}) as Record<string, unknown>;
        const flag = (key: string, fallback: boolean) => (typeof values[key] === 'boolean' ? values[key] : fallback);
        const text = (key: string, fallback: string) => (typeof values[key] === 'string' && values[key] ? values[key] : fallback);
        const data = list === 'payment-methods'
          ? [
              { id: 'bank_transfer', label: 'Bank transfer', enabled: flag('mBank', true) },
              { id: 'upi', label: 'UPI', enabled: flag('mUPI', true) },
              { id: 'net_banking', label: 'Net banking', enabled: flag('mNet', true) },
              { id: 'btc', label: 'Bitcoin', enabled: flag('mBTC', Boolean(process.env.BTC_RECEIVING_ADDRESS)) },
              { id: 'lc', label: 'Letter of credit', enabled: true },
            ]
          : {
              beneficiary: text('bankName', process.env.PAYMENT_BENEFICIARY ?? 'Mineral Bridge Ltd'),
              bank: text('bankBank', process.env.PAYMENT_BANK ?? 'Example Bank'),
              account: text('bankAcct', process.env.PAYMENT_ACCOUNT ?? '0000000000'),
              swift: text('bankSwift', process.env.PAYMENT_SWIFT ?? 'EXAMPLEXXX'),
              upiId: text('bankUpi', process.env.PAYMENT_UPI ?? ''),
            };
        res.setHeader('Cache-Control', 'private, max-age=30');
        res.json({ list, items: data });
        return;
      }
      const data = LISTS[list];
      if (!data) {
        res.status(404).json({ code: 'reference/unknown-list', message: 'Unknown reference list' });
        return;
      }
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.json({ list, items: data });
    }),
  );
  return r;
}
