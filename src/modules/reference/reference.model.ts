import { Schema } from 'mongoose';
import { defineModel } from '../../common/db/define-model.js';
import { moneySchema } from '../../models/shared.js';

/** Shared reference data (web + admin + mobile). Inserted on API startup when missing. */

const categorySchema = new Schema<any>(
  {
    categoryId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    position: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { versionKey: false },
);
export const MineralCategory = defineModel('MineralCategory', categorySchema, 'ref_categories');

const mineralSchema = new Schema<any>(
  {
    mineralId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    categoryId: { type: String, index: true },
    subcategorySlug: String,
    mineralTypeSlug: String,
    productFormSlug: String,
    units: [{ type: String }],
    grades: [{ type: String }],
    active: { type: Boolean, default: true },
  },
  { versionKey: false },
);
export const Mineral = defineModel('Mineral', mineralSchema, 'ref_minerals');

const unitSchema = new Schema<any>(
  {
    code: { type: String, required: true, unique: true },
    name: String,
    grams: { type: Number, required: true },
  },
  { versionKey: false },
);
export const Unit = defineModel('Unit', unitSchema, 'ref_units');

/** Country reference + admin Bitcoin-settlement toggle (#133/#134). */
const countrySchema = new Schema<any>(
  {
    code: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    dialCode: String,
    currency: String,
    btc: {
      regulation: { type: String, enum: ['permitted_vasp', 'permitted_limited', 'restricted', 'prohibited'], default: 'restricted' },
      regulationLabel: String,
      rail: { type: String, enum: ['lightning_and_onchain', 'on_chain', 'lightning', 'none'], default: 'none' },
      limit: moneySchema,
      enabled: { type: Boolean, default: false },
    },
  },
  { versionKey: false },
);
export const Country = defineModel('Country', countrySchema, 'ref_countries');

const bankSchema = new Schema<any>(
  {
    bankId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    country: String,
    swift: String,
    active: { type: Boolean, default: true },
  },
  { versionKey: false },
);
export const Bank = defineModel('Bank', bankSchema, 'ref_banks');
