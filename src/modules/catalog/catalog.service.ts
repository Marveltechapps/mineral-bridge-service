import type { FilterQuery } from 'mongoose';
import { notFound } from '../../common/errors/app-error.js';
import { CategoryModel, MineralTypeModel, ProductFormModel, ProductModel, SubcategoryModel } from '../../models/catalog.model.js';
import type { ICategory, IMineralType, IProduct, IProductForm, ISubcategory } from '../../models/catalog.model.js';
import { slugify } from './sheet-sync.js';
import { repairCatalogImageUrl } from './hierarchy.js';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export type ProductQuery = {
  category?: string;
  subcategory?: string;
  type?: string;
  productForm?: string;
  mineral?: string;
  country?: string;
  q?: string;
  grade?: string;
  assured?: boolean;
  verified?: boolean;
  minGrams?: number;
  maxUnitPrice?: number;
  sort?: 'newest' | 'price_asc' | 'price_desc';
};

function productFilter(q: ProductQuery): FilterQuery<IProduct> {
  const and: FilterQuery<IProduct>[] = [
    { status: 'active' },
    // Sheet-backed catalog rows stay visible at zero stock so the published
    // mineral still appears. Inventory lots still require grams on hand.
    { $or: [{ availableGrams: { $gt: 0 } }, { 'attributes.sourceSheet': true }] },
  ];
  const f: FilterQuery<IProduct> = {};
  if (q.category) f.categorySlug = q.category;
  if (q.subcategory) {
    and.push({ $or: [{ subcategorySlug: q.subcategory }, { typeSlug: q.subcategory }] });
  }
  if (q.type) f.typeSlug = q.type;
  if (q.productForm) f.productFormSlug = q.productForm;
  if (q.mineral) f.mineralCode = q.mineral.toUpperCase();
  if (q.country) f['origin.country'] = q.country.toUpperCase();
  if (q.grade) f.grade = q.grade;
  if (q.assured !== undefined) f.assured = q.assured;
  if (q.verified !== undefined) f.verified = q.verified;
  if (q.minGrams) and.push({ availableGrams: { $gte: q.minGrams } });
  if (q.maxUnitPrice) f.unitPriceMinorE4PerGram = { $lte: q.maxUnitPrice * 10_000 };
  if (q.q) {
    const re = new RegExp(escapeRe(q.q), 'i');
    and.push({
      $or: [
        { name: re },
        { mineralCode: re },
        { typeSlug: re },
        { subcategorySlug: re },
        { productFormSlug: re },
        { description: re },
        { 'attributes.productFormName': re },
        { 'attributes.mineralTypeName': re },
        { 'attributes.subcategoryName': re },
        { 'attributes.categoryName': re },
      ],
    });
  }
  f.$and = and;
  return f;
}

function storedText(attributes: IProduct['attributes'] | undefined, key: string): string {
  const value = attributes?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

interface HierarchyFormNode {
  id: string;
  slug: string;
  name: string;
  categorySlug: string;
  subcategorySlug: string;
  mineralTypeSlug: string;
  imageUrl: string | null;
  imageName: string | null;
  sourceId: string | null;
  sourceSheet: boolean;
  isActive: boolean;
}
interface HierarchyTypeNode {
  id: string;
  slug: string;
  name: string;
  categorySlug: string;
  subcategorySlug: string | null;
  imageUrl: string | null;
  imageName: string | null;
  sourceId: string | null;
  isActive: boolean;
  productForms: HierarchyFormNode[];
}
interface HierarchySubNode {
  id: string;
  slug: string;
  name: string;
  categorySlug: string;
  imageUrl: string | null;
  imageName: string | null;
  sourceId: string | null;
  isActive: boolean;
  mineralTypes: HierarchyTypeNode[];
}
interface HierarchyCategoryNode {
  slug: string;
  imageUrl: string | null;
  subcategories: HierarchySubNode[];
}

/**
 * Lots imported before the subcategory and product-form collections existed
 * still store the sheet subcategory name and the mineral name. Those stored
 * values fill gaps in the hierarchy. A missing subcategory name is left blank.
 */
function attachStoredProducts(tree: HierarchyCategoryNode[], products: IProduct[]) {
  for (const product of products) {
    const subcategoryName = storedText(product.attributes, 'subcategoryName');
    if (!product.categorySlug || !subcategoryName) continue;
    const category = tree.find((row) => row.slug === product.categorySlug);
    if (!category) continue;
    const subcategorySlug = product.subcategorySlug || slugify(`${product.categorySlug}-${subcategoryName}`);
    let subcategory = category.subcategories.find((row) => row.slug === subcategorySlug || row.name === subcategoryName);
    if (!subcategory) {
      subcategory = {
        id: subcategorySlug,
        slug: subcategorySlug,
        name: subcategoryName,
        categorySlug: product.categorySlug,
        imageUrl: null,
        imageName: null,
        sourceId: null,
        isActive: true,
        mineralTypes: [],
      };
      category.subcategories.push(subcategory);
    }
    const mineralTypeName = storedText(product.attributes, 'mineralTypeName') || subcategoryName;
    const mineralTypeSlug = product.typeSlug || subcategory.slug;
    let mineralType = subcategory.mineralTypes.find((row) => row.slug === mineralTypeSlug);
    if (!mineralType) {
      mineralType = {
        id: mineralTypeSlug,
        slug: mineralTypeSlug,
        name: mineralTypeName,
        categorySlug: product.categorySlug,
        subcategorySlug: subcategory.slug,
        imageUrl: null,
        imageName: null,
        sourceId: null,
        isActive: true,
        productForms: [],
      };
      subcategory.mineralTypes.push(mineralType);
    }
    const formName = storedText(product.attributes, 'productFormName') || product.name;
    if (!formName) continue;
    const imageUrl = repairCatalogImageUrl(product.imageUrl);
    if (!category.imageUrl && imageUrl) category.imageUrl = imageUrl;
    if (!subcategory.imageUrl && imageUrl) subcategory.imageUrl = imageUrl;
    if (!mineralType.imageUrl && imageUrl) mineralType.imageUrl = imageUrl;
    const formSlug = product.productFormSlug || slugify(`${mineralType.slug}-${formName}`);
    if (mineralType.productForms.some((form) => form.slug === formSlug || form.name === formName)) continue;
    const sourceSheet = product.attributes?.sourceSheet === true;
    mineralType.productForms.push({
      id: product._id,
      slug: formSlug,
      name: formName,
      categorySlug: product.categorySlug,
      subcategorySlug: subcategory.slug,
      mineralTypeSlug: mineralType.slug,
      imageUrl,
      imageName: product.imageName ?? null,
      sourceId: product.mineralCode || null,
      sourceSheet,
      isActive: true,
    });
  }
  for (const category of tree) {
    category.subcategories.sort((a, b) => a.name.localeCompare(b.name));
    for (const subcategory of category.subcategories) {
      subcategory.mineralTypes.sort((a, b) => a.name.localeCompare(b.name));
      for (const mineralType of subcategory.mineralTypes) {
        mineralType.productForms.sort((a, b) => a.name.localeCompare(b.name));
      }
    }
  }
}

const sortFor = (s?: string): Record<string, 1 | -1> =>
  s === 'price_asc' ? { unitPriceMinorE4PerGram: 1 as const, _id: 1 as const } : s === 'price_desc' ? { unitPriceMinorE4PerGram: -1 as const, _id: 1 as const } : s === 'name' ? { name: 1 as const, _id: 1 as const } : { createdAt: -1 as const, _id: 1 as const };

export const catalogService = {
  categories: () => CategoryModel.find({ active: true }).sort({ sort: 1, name: 1 }).lean<ICategory[]>(),

  types: (category?: string, subcategory?: string) =>
    MineralTypeModel.find({
      active: true,
      ...(category ? { categorySlug: category } : {}),
      ...(subcategory ? { subcategorySlug: subcategory } : {}),
    }).sort({ sort: 1, name: 1 }).lean<IMineralType[]>(),

  subcategories: (category?: string) =>
    SubcategoryModel.find({ active: true, ...(category ? { categorySlug: category } : {}) }).sort({ sort: 1, name: 1 }).lean<ISubcategory[]>(),

  productForms: (mineralType?: string) =>
    ProductFormModel.find({ active: true, ...(mineralType ? { mineralTypeSlug: mineralType } : {}) }).sort({ sort: 1, name: 1 }).lean<IProductForm[]>(),

  async hierarchy() {
    const [categories, subcategories, types, forms, products] = await Promise.all([
      catalogService.categories(),
      catalogService.subcategories(),
      catalogService.types(),
      catalogService.productForms(),
      ProductModel.find({ status: 'active' })
        .select('name categorySlug subcategorySlug typeSlug productFormSlug imageUrl imageName mineralCode attributes')
        .lean<IProduct[]>(),
    ]);
    const tree = categories.map((category) => ({
      id: category._id,
      slug: category.slug,
      name: category.name,
      imageUrl: repairCatalogImageUrl(category.imageUrl),
      imageName: category.imageName ?? null,
      sourceId: category.sourceId ?? null,
      isActive: category.active,
      subcategories: subcategories
        .filter((sub) => sub.categorySlug === category.slug)
        .map((sub) => ({
          id: sub._id,
          slug: sub.slug,
          name: sub.name,
          categorySlug: sub.categorySlug,
          imageUrl: repairCatalogImageUrl(sub.imageUrl),
          imageName: sub.imageName ?? null,
          sourceId: sub.sourceId ?? null,
          isActive: sub.active,
          mineralTypes: types
            .filter((type) => type.subcategorySlug === sub.slug)
            .map((type) => ({
              id: type._id,
              slug: type.slug,
              name: type.name,
              categorySlug: type.categorySlug,
              subcategorySlug: type.subcategorySlug ?? null,
              imageUrl: repairCatalogImageUrl(type.imageUrl),
              imageName: type.imageName ?? null,
              sourceId: type.sourceId ?? null,
              isActive: type.active,
              productForms: forms
                .filter((form) => form.mineralTypeSlug === type.slug)
                .map((form) => ({
                  id: form._id,
                  slug: form.slug,
                  name: form.name,
                  categorySlug: form.categorySlug,
                  subcategorySlug: form.subcategorySlug,
                  mineralTypeSlug: form.mineralTypeSlug,
                  imageUrl: repairCatalogImageUrl(form.imageUrl),
                  imageName: form.imageName ?? null,
                  sourceId: form.sourceId ?? null,
                  sourceSheet: form.sourceSheet,
                  isActive: form.active,
                })),
            })),
        })),
    }));
    attachStoredProducts(tree, products);
    return tree;
  },

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
    const [categories, subcategories, types, forms, countries, price] = await Promise.all([
      catalogService.categories(),
      catalogService.subcategories(),
      catalogService.types(),
      catalogService.productForms(),
      ProductModel.distinct('origin.country', { status: 'active' }),
      ProductModel.aggregate<{ min: number; max: number }>([
        { $match: { status: 'active' } },
        { $group: { _id: null, min: { $min: '$unitPriceMinorE4PerGram' }, max: { $max: '$unitPriceMinorE4PerGram' } } },
      ]),
    ]);
    return { categories, subcategories, types, forms, countries: countries as string[], price: price[0] ?? { min: 0, max: 0 } };
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
