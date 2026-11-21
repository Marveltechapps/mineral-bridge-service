import { Schema } from 'mongoose';

/** Actor who performed a state change (customer, staff, system, or partner). */
export type ActorKind = 'customer' | 'staff' | 'system' | 'partner';

export interface ActorRef {
  kind: ActorKind;
  id: string;
  name?: string;
  role?: string;
}

export const actorRefDef = {
  kind: { type: String, enum: ['customer', 'staff', 'system', 'partner'], required: true },
  id: { type: String, required: true },
  name: String,
  role: String,
} as const;

export const actorRefSchema = new Schema(actorRefDef, { _id: false });

/** Quantity in base units: milligrams for mass, pieces for count. */
export type QtyMeasure = 'mass' | 'count';
export type QtyUnit = 'g' | 'kg' | 't' | 'oz' | 'ct' | 'pc' | 'bar';

export interface QtyDoc {
  measure: QtyMeasure;
  unit: QtyUnit;
  availableBase?: number;
  reservedBase?: number;
  minBase?: number;
  stepBase?: number;
  /** Alias used on line/sell payloads where a single base amount is stored. */
  base?: number;
}

export const qtyDef = {
  measure: { type: String, enum: ['mass', 'count'], required: true },
  unit: { type: String, enum: ['g', 'kg', 't', 'oz', 'ct', 'pc', 'bar'], required: true },
  availableBase: { type: Number, validate: { validator: (n: number) => n == null || Number.isSafeInteger(n) } },
  reservedBase: { type: Number, validate: { validator: (n: number) => n == null || Number.isSafeInteger(n) } },
  minBase: { type: Number, validate: { validator: (n: number) => n == null || Number.isSafeInteger(n) } },
  stepBase: { type: Number, validate: { validator: (n: number) => n == null || Number.isSafeInteger(n) } },
  base: { type: Number, validate: { validator: (n: number) => n == null || Number.isSafeInteger(n) } },
} as const;

export const qtySchema = new Schema(qtyDef, { _id: false });

/** Unit price: minor units per one `per` unit. */
export interface UnitPriceDoc {
  amountMinor: number;
  currency: string;
  per: QtyUnit;
}

export const unitPriceDef = {
  amountMinor: {
    type: Number,
    required: true,
    validate: { validator: Number.isSafeInteger, message: 'amountMinor must be a safe integer' },
  },
  currency: { type: String, required: true, default: 'USD' },
  per: { type: String, enum: ['g', 'kg', 't', 'oz', 'ct', 'pc', 'bar'], required: true },
} as const;

export const unitPriceSchema = new Schema(unitPriceDef, { _id: false });

export interface EntityRef {
  type: string;
  id: string;
}

export const entityRefDef = {
  type: { type: String, required: true },
  id: { type: String, required: true },
} as const;

export const entityRefSchema = new Schema(entityRefDef, { _id: false });

export const ROLE_KEYS = [
  'super',
  'ops',
  'trading',
  'compliance',
  'inspection',
  'finance',
  'logistics',
  'catalogue',
  'support',
] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export const ACTION_PERMISSIONS = [
  'ops',
  'trading',
  'auction',
  'kyc',
  'suspend',
  'inspection',
  'finance',
  'logistics',
  'catalogue',
  'support',
  'remind',
  'settings',
  'super',
] as const;
export type ActionPermission = (typeof ACTION_PERMISSIONS)[number];

export const BUYER_TYPES = ['refinery', 'house', 'industry', 'jewel', 'investor', 'wholesale'] as const;
export const SELLER_TYPES = ['asm', 'industrial', 'coop', 'dealer', 'form', 'scrap'] as const;

export const WORKFLOW_OWNERS = ['customer', 'platform', 'logistics', 'inspector'] as const;
export const HOLD_TYPES = ['declined', 'discrepancy', 'refund', 'changes', 'clarify'] as const;
