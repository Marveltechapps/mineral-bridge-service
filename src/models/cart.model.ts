import type { MoneyDoc } from './_shared.js';
import { defineModel, pk, SubDocId } from './_shared.js';

export interface ICart {
  _id: string;
  userId: string;
  items: {
    _id: string;
    productId: string;
    grams: number;
    qty?: { unit: string; base: number };
    addedAt: Date;
  }[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const CartModel = defineModel<ICart>(
  'Cart',
  {
    _id: pk('crt'),
    userId: { type: String, required: true, unique: true },
    items: [
      {
        _id: SubDocId('cit'),
        productId: { type: String, required: true },
        grams: { type: Number, required: true, min: 0 },
        qty: { unit: String, base: Number },
        addedAt: { type: Date, default: Date.now },
      },
    ],
    version: { type: Number, default: 0 },
  },
);

/** Server-issued price quote (web `quoteId`; short lived so the buyer gets the price they saw). */
export interface IQuote {
  _id: string;
  userId?: string;
  lotId: string;
  grams: number;
  paymentMethod: string;
  unitPriceMinorE4PerGram: number;
  subtotal: MoneyDoc;
  platformFee: MoneyDoc;
  surcharge: MoneyDoc;
  total: MoneyDoc;
  expiresAt: Date;
  createdAt: Date;
}

export const QuoteModel = defineModel<IQuote>(
  'Quote',
  {
    _id: pk('qte'),
    userId: String,
    lotId: { type: String, required: true },
    grams: { type: Number, required: true },
    paymentMethod: { type: String, required: true },
    unitPriceMinorE4PerGram: { type: Number, required: true },
    subtotal: { type: Object, required: true },
    platformFee: { type: Object, required: true },
    surcharge: { type: Object, required: true },
    total: { type: Object, required: true },
    expiresAt: { type: Date, required: true },
  },
  { indexes: [[{ expiresAt: 1 }, { expireAfterSeconds: 3600 }]] },
);
