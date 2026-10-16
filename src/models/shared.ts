import { Schema } from 'mongoose';
import { moneySub, quantitySub, refSub, unitPriceSub } from '../modules/admin/shared/money.js';

/** Persisted money: integer minor units (amountMinor) + currency + scale. Never major units. */
export const moneySchema = new Schema<any>(moneySub, { _id: false });
export const unitPriceSchema = new Schema<any>(unitPriceSub, { _id: false });
export const quantitySchema = new Schema<any>(quantitySub, { _id: false });
export const refSchema = new Schema<any>(refSub, { _id: false });

export const MODULES = [
  'orders',
  'vault',
  'pricing',
  'auctions',
  'users',
  'compliance',
  'content',
  'financial',
  'settings',
  'support',
] as const;
export type PermissionModule = (typeof MODULES)[number];
export type AccessLevel = 'none' | 'view' | 'edit';

export const RECORD_TYPES = [
  'order', 'lot', 'listing', 'auction', 'lc', 'negotiation', 'contract', 'passport', 'anchor',
  'user', 'kyc', 'document', 'tier_request', 'dispute', 'ticket', 'settlement', 'rate', 'offer', 'intake',
  'course', 'partner', 'role',
] as const;
export type RecordType = (typeof RECORD_TYPES)[number];
