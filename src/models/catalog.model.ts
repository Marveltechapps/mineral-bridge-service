import { defineModel, pk, SubDocId } from './_shared.js';

export interface ICategory {
  _id: string;
  slug: string;
  name: string;
  description?: string;
  imageUrl?: string;
  sort: number;
  active: boolean;
}

export const CategoryModel = defineModel<ICategory>(
  'Category',
  {
    _id: pk('cat'),
    slug: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    description: String,
    imageUrl: String,
    sort: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
);

export interface IMineralType {
  _id: string;
  slug: string;
  categorySlug: string;
  mineralCode?: string;
  name: string;
  /** Minerals sellable in the mobile sell flow carry the tiers they accept. */
  sellable: boolean;
  tiers: number[];
  imageUrl?: string;
  sort: number;
  active: boolean;
}

export const MineralTypeModel = defineModel<IMineralType>(
  'MineralType',
  {
    _id: pk('typ'),
    slug: { type: String, required: true, unique: true },
    categorySlug: { type: String, required: true, index: true },
    mineralCode: String,
    name: { type: String, required: true },
    sellable: { type: Boolean, default: true },
    tiers: { type: [Number], default: [1, 2, 3] },
    imageUrl: String,
    sort: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
);

export type ProductStatus = 'draft' | 'active' | 'sold' | 'withdrawn';

export interface IProduct {
  _id: string; // prd_... (mobile "product" == web "lot": one inventory collection)
  reference: string; // MBV-...
  name: string;
  typeSlug: string;
  categorySlug: string;
  mineralCode: string;
  purity?: string;
  grade?: string;
  origin: { country: string; region?: string; site?: string };
  /** Owning customer, when the lot is listed by a user; platform inventory has none. */
  sellerId?: string;
  seller: { name: string; tier: 'cooperative' | 'registered' | 'individual' | 'mineral_bridge'; verified: boolean };
  status: ProductStatus;
  availableGrams: number;
  minOrderGrams: number;
  stepGrams: number;
  currency: string;
  unitPriceMinorE4PerGram: number;
  assured: boolean;
  verified: boolean;
  imageUrl?: string;
  gradientFrom?: string;
  gradientTo?: string;
  description?: string;
  attributes: Record<string, string | number | boolean>;
  media: { _id: string; kind: 'image' | 'video' | 'document'; url: string; thumbnailUrl?: string; sort: number }[];
  provenance: { _id: string; stage: string; title: string; detail?: string; at: Date; location?: string; hash?: string }[];
  documents: { _id: string; name: string; kind: string; fileId?: string; url?: string; bytes?: number; contentType?: string }[];
  passportId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export const ProductModel = defineModel<IProduct>(
  'Product',
  {
    _id: pk('prd'),
    reference: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    typeSlug: { type: String, required: true },
    categorySlug: { type: String, required: true },
    mineralCode: { type: String, required: true },
    purity: String,
    grade: String,
    origin: { country: { type: String, required: true }, region: String, site: String },
    sellerId: String,
    seller: {
      name: { type: String, default: 'Mineral Bridge' },
      tier: { type: String, enum: ['cooperative', 'registered', 'individual', 'mineral_bridge'], default: 'mineral_bridge' },
      verified: { type: Boolean, default: true },
    },
    status: { type: String, enum: ['draft', 'active', 'sold', 'withdrawn'], default: 'active' },
    availableGrams: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
    minOrderGrams: { type: Number, default: 50 },
    stepGrams: { type: Number, default: 50 },
    currency: { type: String, default: 'USD' },
    unitPriceMinorE4PerGram: { type: Number, required: true, min: 0 },
    assured: { type: Boolean, default: false },
    verified: { type: Boolean, default: true },
    imageUrl: String,
    gradientFrom: String,
    gradientTo: String,
    description: String,
    attributes: { type: Object, default: {} },
    media: [
      {
        _id: SubDocId('med'),
        kind: { type: String, enum: ['image', 'video', 'document'], default: 'image' },
        url: { type: String, required: true },
        thumbnailUrl: String,
        sort: { type: Number, default: 0 },
      },
    ],
    provenance: [
      {
        _id: SubDocId('pev'),
        stage: String,
        title: String,
        detail: String,
        at: Date,
        location: String,
        hash: String,
      },
    ],
    documents: [
      {
        _id: SubDocId('doc'),
        name: String,
        kind: String,
        fileId: String,
        url: String,
        bytes: Number,
        contentType: String,
      },
    ],
    passportId: String,
  },
  {
    indexes: [
      [{ typeSlug: 1, status: 1, createdAt: -1 }],
      [{ categorySlug: 1, status: 1 }],
      [{ name: 'text', description: 'text', mineralCode: 'text' }],
    ],
    schema: { minimize: false },
  },
);
