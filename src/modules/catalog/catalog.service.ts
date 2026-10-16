import type { FilterQuery } from 'mongoose';
import { notFound } from '../../common/errors/app-error.js';
import { CategoryModel, MineralTypeModel, ProductModel } from '../../models/catalog.model.js';
import type { ICategory, IMineralType, IProduct } from '../../models/catalog.model.js';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export type ProductQuery = {
  category?: string;
  type?: string;
  mineral?: string;
  country?: string;
  q?: string;
  assured?: boolean;
  verified?: boolean;
  minGrams?: number;
  maxUnitPrice?: number;
  sort?: 'newest' | 'price_asc' | 'price_desc';
};

function productFilter(q: ProductQuery): FilterQuery<IProduct> {
  const f: FilterQuery<IProduct> = { status: 'active', availableGrams: { $gt: 0 } };
  if (q.category) f.categorySlug = q.category;
  if (q.type) f.typeSlug = q.type;
  if (q.mineral) f.mineralCode = q.mineral.toUpperCase();
  if (q.country) f['origin.country'] = q.country.toUpperCase();
  if (q.assured !== undefined) f.assured = q.assured;
  if (q.verified !== undefined) f.verified = q.verified;
  if (q.minGrams) f.availableGrams = { $gte: q.minGrams };
  if (q.maxUnitPrice) f.unitPriceMinorE4PerGram = { $lte: q.maxUnitPrice * 10_000 };
  if (q.q) {
    const re = new RegExp(escapeRe(q.q), 'i');
    f.$or = [{ name: re }, { mineralCode: re }, { typeSlug: re }, { description: re }];
  }
  return f;
}

const sortFor = (s?: string): Record<string, 1 | -1> =>
  s === 'price_asc' ? { unitPriceMinorE4PerGram: 1 as const, _id: 1 as const } : s === 'price_desc' ? { unitPriceMinorE4PerGram: -1 as const, _id: 1 as const } : { createdAt: -1 as const, _id: 1 as const };

export const catalogService = {
  categories: () => CategoryModel.find({ active: true }).sort({ sort: 1, name: 1 }).lean<ICategory[]>(),

  types: (category?: string) =>
    MineralTypeModel.find({ active: true, ...(category ? { categorySlug: category } : {}) }).sort({ sort: 1, name: 1 }).lean<IMineralType[]>(),

  async typeNames(): Promise<Map<string, string>> {
    const types = await MineralTypeModel.find({}).select('slug name').lean<IMineralType[]>();
    return new Map(types.map((t) => [t.slug, t.name]));
  },

  async listProducts(q: ProductQuery, skip: number, limit: number) {
    const filter = productFilter(q);
    const [rows, total] = await Promise.all([
      ProductModel.find(filter).sort(sortFor(q.sort)).skip(skip).limit(limit).lean<IProduct[]>(),
      ProductModel.countDocuments(filter),
    ]);
    return { rows, total };
  },

  async getProduct(id: string): Promise<IProduct> {
    const p = await ProductModel.findOne({ _id: id, status: { $ne: 'draft' } }).lean<IProduct>();
    if (!p) throw notFound('catalog/product-not-found', 'Product not found');
    return p;
  },

  async filters() {
    const [categories, types, countries, price] = await Promise.all([
      catalogService.categories(),
      catalogService.types(),
      ProductModel.distinct('origin.country', { status: 'active' }),
      ProductModel.aggregate<{ min: number; max: number }>([
        { $match: { status: 'active' } },
        { $group: { _id: null, min: { $min: '$unitPriceMinorE4PerGram' }, max: { $max: '$unitPriceMinorE4PerGram' } } },
      ]),
    ]);
    return { categories, types, countries: countries as string[], price: price[0] ?? { min: 0, max: 0 } };
  },

  /** Web facet counts over the same filter (minus the facet's own dimension would be nicer; kept simple). */
  async facets(q: ProductQuery) {
    const filter = productFilter(q);
    const count = (field: string) =>
      ProductModel.aggregate<{ _id: string; count: number }>([{ $match: filter }, { $group: { _id: `$${field}`, count: { $sum: 1 } } }, { $sort: { count: -1 } }]);
    const [minerals, categories, countries, verified] = await Promise.all([
      count('mineralCode'),
      count('categorySlug'),
      count('origin.country'),
      count('verified'),
    ]);
    const m = (rows: { _id: string; count: number }[]) => rows.map((r) => ({ value: r._id, count: r.count }));
    return { minerals: m(minerals), categories: m(categories), countries: m(countries), verified: m(verified) };
  },
};
