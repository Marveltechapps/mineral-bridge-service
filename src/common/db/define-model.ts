import mongoose, { type Model, type Schema } from 'mongoose';

/**
 * Admin-domain models are registered as `Adm<Name>` on `adm_<collection>`.
 *
 * The customer-facing modules (mobile/web) own their own Mongoose models and collections
 * (`modules/users`, `modules/kyc`, `models/*.model.ts`, …). Registering the admin schemas under the
 * same model names / collections would silently clobber one set of schemas with the other, so the
 * admin domain is namespaced. Bridging customer collections into admin read-models is an explicit
 * integration step documented in docs/DATABASE.md ("Customer ↔ admin collections").
 *
 * Documents are intentionally loosely typed: the wire contract is enforced by the DTO mappers and
 * zod validators, not by Mongoose inference.
 */
export type AnyDoc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function defineModel(name: string, schema: Schema, collection?: string): Model<AnyDoc> {
  const modelName = `Adm${name}`;
  const existing = mongoose.models[modelName] as Model<AnyDoc> | undefined;
  if (existing) return existing;
  return mongoose.model<AnyDoc>(modelName, schema, `adm_${collection ?? `${name.toLowerCase()}s`}`);
}

export const timestampFields = {
  createdAt: { type: Date },
  updatedAt: { type: Date },
};
