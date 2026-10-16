import mongoose, { Schema } from 'mongoose';
import type { IndexDefinition, IndexOptions, Model, SchemaOptions } from 'mongoose';
import { opaqueId } from '../common/utils/ids.js';

/** Persisted money: integer minor units + ISO currency. `scale` is derived from the exponent table. */
export type MoneyDoc = { amountMinor: number; currency: string };

export const moneyDef = {
  amountMinor: {
    type: Number,
    required: true,
    validate: { validator: Number.isSafeInteger, message: 'amountMinor must be a safe integer' },
  },
  currency: { type: String, required: true, default: 'USD' },
} as const;

export const moneyField = (required = false) => ({
  type: new Schema(moneyDef, { _id: false }),
  required,
});

/** String primary key with an opaque prefix (`ord_...`). */
export const pk = (prefix: string) => ({ type: String, default: () => opaqueId(prefix) });

export type ModelIndex = [IndexDefinition, IndexOptions?];

/**
 * Registers a model from a loose schema definition while keeping a strict TypeScript interface for
 * consumers. Idempotent so test files and hot-reload can import it repeatedly.
 */
export function defineModel<I>(
  name: string,
  definition: Record<string, unknown>,
  options: { indexes?: ModelIndex[]; schema?: SchemaOptions } = {},
): Model<I> {
  // Prefixed so the customer marketplace never shares a mongoose model/collection name with the admin console.
  const modelName = `Cust${name}`;
  const existing = mongoose.models[modelName];
  if (existing) return existing as unknown as Model<I>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema = new Schema<any>(definition as any, { timestamps: true, versionKey: false, ...(options.schema as object) });
  for (const [fields, opts] of options.indexes ?? []) schema.index(fields, opts);
  const collection = `cust_${name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}s`;
  return mongoose.model(modelName, schema, collection) as unknown as Model<I>;
}

export interface Timestamps {
  createdAt: Date;
  updatedAt: Date;
}

export const SubDocId = (prefix: string) => ({ type: String, default: () => opaqueId(prefix) });
