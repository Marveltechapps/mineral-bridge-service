/**
 * Catalogue hierarchy writes for the admin console.
 *
 * The data model is Category -> Subcategory -> Mineral type -> Product form. The console shows two
 * levels: a category and the "subcategories" inside it. A console subcategory is a mineral type,
 * because lots carry the mineral type slug (`typeSlug`). When the console adds one, a same-named
 * Subcategory row is created or reused so the type also appears in the customer apps' hierarchy.
 *
 * Nothing here removes a record that lots are attached to. Hiding (`active: false`) is the way to
 * take a populated node out of the apps.
 */
import { conflict, notFound, unprocessable } from '../../../common/errors/app-error.js';
import {
  CategoryModel,
  MineralTypeModel,
  ProductFormModel,
  ProductModel,
  SubcategoryModel,
  type ICategory,
  type IMineralType,
  type ISubcategory,
} from '../../../models/catalog.model.js';
import { recordAudit } from '../../audit/audit.service.js';
import { slugify } from '../../catalog/sheet-sync.js';

export type CatalogueStaff = { id: string; name: string; publicId?: string };

const NAME_MAX = 120;

function cleanName(raw: string, field = 'name'): string {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2) throw unprocessable('Give it a name of at least 2 characters.', { [field]: 'Required' });
  if (name.length > NAME_MAX) throw unprocessable(`Use at most ${NAME_MAX} characters.`, { [field]: 'Too long' });
  return name;
}

function cleanSlug(raw: string | undefined, fallback: string): string {
  const slug = slugify(raw?.trim() || fallback);
  if (!slug) throw unprocessable('Use letters or numbers in the name.', { slug: 'Invalid' });
  return slug;
}

async function audit(staff: CatalogueStaff, action: string, record: { type: string; id: string; label?: string }, after?: unknown, before?: unknown) {
  await recordAudit({
    actor: { staffId: staff.publicId || staff.id, name: staff.name },
    category: 'catalogue',
    action,
    record,
    before,
    after,
  });
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function dupKey(err: unknown): boolean {
  return (err as { code?: number }).code === 11000;
}

async function lotsUnder(filter: Record<string, unknown>): Promise<number> {
  return ProductModel.countDocuments(filter);
}

export interface CatalogueMineralNode {
  slug: string;
  name: string;
  subcategorySlug: string | null;
  active: boolean;
  sellable: boolean;
  mineralCode: string | null;
  lots: number;
}
export interface CatalogueCategoryNode {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  active: boolean;
  sort: number;
  subcategories: { slug: string; name: string; active: boolean; minerals: number }[];
  minerals: CatalogueMineralNode[];
  lots: number;
}

/** The whole hierarchy including hidden nodes, with lot counts. This is what the console edits. */
export async function catalogueTree(): Promise<CatalogueCategoryNode[]> {
  const [cats, subs, types, counts] = await Promise.all([
    CategoryModel.find({}).sort({ sort: 1, name: 1 }).lean<ICategory[]>(),
    SubcategoryModel.find({}).sort({ sort: 1, name: 1 }).lean<ISubcategory[]>(),
    MineralTypeModel.find({}).sort({ sort: 1, name: 1 }).lean<IMineralType[]>(),
    ProductModel.aggregate<{ _id: { type: string }; n: number }>([{ $group: { _id: { type: '$typeSlug' }, n: { $sum: 1 } } }]),
  ]);
  const lotsByType = new Map(counts.map((row) => [row._id.type, row.n]));
  return cats.map((category) => {
    const minerals = types.filter((t) => t.categorySlug === category.slug).map((t) => ({
      slug: t.slug,
      name: t.name,
      subcategorySlug: t.subcategorySlug ?? null,
      active: t.active,
      sellable: t.sellable,
      mineralCode: t.mineralCode ?? null,
      lots: lotsByType.get(t.slug) ?? 0,
    }));
    return {
      id: category._id,
      slug: category.slug,
      name: category.name,
      description: category.description ?? null,
      active: category.active,
      sort: category.sort,
      subcategories: subs.filter((s) => s.categorySlug === category.slug).map((s) => ({
        slug: s.slug,
        name: s.name,
        active: s.active,
        minerals: minerals.filter((m) => m.subcategorySlug === s.slug).length,
      })),
      minerals,
      lots: minerals.reduce((sum, m) => sum + m.lots, 0),
    };
  });
}

/** Console shape: `[{ id, label, active, subs: [{ id, label, active }] }]`, ids are slugs. */
export async function consoleCategories() {
  const tree = await catalogueTree();
  return tree.map((c) => ({
    id: c.slug,
    label: c.name,
    active: c.active,
    live: true,
    subs: c.minerals.map((m) => ({ id: m.slug, label: m.name, active: m.active, live: true })),
  }));
}

async function requireCategory(slug: string): Promise<ICategory> {
  const category = await CategoryModel.findOne({ slug }).lean<ICategory>();
  if (!category) throw notFound('category/not-found', 'Category not found');
  return category;
}

async function requireMineral(slug: string): Promise<IMineralType> {
  const type = await MineralTypeModel.findOne({ slug }).lean<IMineralType>();
  if (!type) throw notFound('mineral/not-found', 'Subcategory not found');
  return type;
}

async function ensureCategoryNameFree(name: string, exceptSlug?: string) {
  const clash = await CategoryModel.findOne({ name: new RegExp(`^${escapeRe(name)}$`, 'i'), ...(exceptSlug ? { slug: { $ne: exceptSlug } } : {}) }).lean();
  if (clash) throw conflict('category/duplicate', 'A category with that name already exists.');
}

/**
 * Finds or creates the Subcategory that a console "subcategory" (a mineral type) hangs off.
 * The Subcategory carries the same name so the customer hierarchy shows it.
 */
async function ensureSubcategoryFor(categorySlug: string, name: string): Promise<string> {
  const existing = await SubcategoryModel.findOne({ categorySlug, name: new RegExp(`^${escapeRe(name)}$`, 'i') }).lean<ISubcategory>();
  if (existing) {
    if (!existing.active) await SubcategoryModel.updateOne({ _id: existing._id }, { $set: { active: true } });
    return existing.slug;
  }
  let slug = slugify(`${categorySlug}-${name}`);
  if (await SubcategoryModel.exists({ slug })) slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
  await SubcategoryModel.create({ slug, name, categorySlug, sort: 0, active: true });
  return slug;
}

async function mineralSlugFor(categorySlug: string, name: string, requested?: string): Promise<string> {
  const base = slugify(requested?.trim() || name);
  if (!base) throw unprocessable('Use letters or numbers in the name.', { name: 'Invalid' });
  if (requested) {
    if (await MineralTypeModel.exists({ slug: base })) throw conflict('mineral/duplicate', 'That subcategory key is already in use.');
    return base;
  }
  if (!(await MineralTypeModel.exists({ slug: base }))) return base;
  const prefixed = slugify(`${categorySlug}-${name}`);
  if (!(await MineralTypeModel.exists({ slug: prefixed }))) return prefixed;
  throw conflict('mineral/duplicate', 'A subcategory with that name already exists.');
}

async function createMineralRow(input: { categorySlug: string; name: string; slug?: string; subcategorySlug?: string; mineralCode?: string; sellable?: boolean }) {
  const name = cleanName(input.name);
  const duplicate = await MineralTypeModel.findOne({ name: new RegExp(`^${escapeRe(name)}$`, 'i') }).lean<IMineralType>();
  if (duplicate) throw conflict('mineral/duplicate', `${name} already exists${duplicate.categorySlug === input.categorySlug ? ' in this category' : ' in another category'}.`);
  let subcategorySlug = input.subcategorySlug;
  if (subcategorySlug) {
    const sub = await SubcategoryModel.findOne({ slug: subcategorySlug }).lean<ISubcategory>();
    if (!sub || sub.categorySlug !== input.categorySlug) throw unprocessable('That subgroup does not belong to this category.', { subcategorySlug: 'Invalid' });
  } else {
    subcategorySlug = await ensureSubcategoryFor(input.categorySlug, name);
  }
  const slug = await mineralSlugFor(input.categorySlug, name, input.slug);
  const row = await MineralTypeModel.create({
    slug,
    name,
    categorySlug: input.categorySlug,
    subcategorySlug,
    mineralCode: input.mineralCode?.trim().toUpperCase() || undefined,
    sellable: input.sellable ?? true,
    tiers: [1, 2, 3],
    sort: 0,
    active: true,
  });
  return row.toObject() as IMineralType;
}

// ---------------------------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------------------------

export async function createCategory(
  input: { name: string; slug?: string; description?: string; sort?: number; subcategories?: string[] },
  staff: CatalogueStaff,
) {
  const name = cleanName(input.name);
  await ensureCategoryNameFree(name);
  const slug = cleanSlug(input.slug, name);
  const names = [...new Set((input.subcategories ?? []).map((n) => n.trim()).filter(Boolean))];
  for (const n of names) cleanName(n, 'subcategories');
  try {
    await CategoryModel.create({ slug, name, description: input.description?.trim() || undefined, sort: input.sort ?? 0, active: true });
  } catch (err) {
    if (dupKey(err)) throw conflict('category/duplicate', 'That category already exists.');
    throw err;
  }
  const minerals: IMineralType[] = [];
  for (const n of names) minerals.push(await createMineralRow({ categorySlug: slug, name: n }));
  await audit(staff, 'Category created', { type: 'Category', id: slug, label: name }, { name, subcategories: names });
  return { slug, name, active: true, minerals: minerals.map((m) => ({ slug: m.slug, name: m.name })) };
}

export async function updateCategory(
  slug: string,
  patch: { name?: string; description?: string; sort?: number; active?: boolean },
  staff: CatalogueStaff,
) {
  const category = await requireCategory(slug);
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const name = cleanName(patch.name);
    if (name !== category.name) {
      await ensureCategoryNameFree(name, slug);
      set.name = name;
    }
  }
  if (patch.description !== undefined) set.description = patch.description.trim();
  if (patch.sort !== undefined) set.sort = patch.sort;
  if (patch.active !== undefined && patch.active !== category.active) set.active = patch.active;
  if (!Object.keys(set).length) return { slug, name: category.name, active: category.active };
  const updated = await CategoryModel.findOneAndUpdate({ slug }, { $set: set }, { new: true }).lean<ICategory>();
  if (!updated) throw notFound('category/not-found', 'Category not found');
  const action = set.active === undefined ? 'Category updated' : set.active ? 'Category shown in app' : 'Category hidden in app';
  await audit(staff, action, { type: 'Category', id: slug, label: updated.name }, set, { name: category.name, active: category.active });
  return { slug, name: updated.name, active: updated.active };
}

export async function deleteCategory(slug: string, staff: CatalogueStaff) {
  const category = await requireCategory(slug);
  const lots = await lotsUnder({ categorySlug: slug });
  if (lots) {
    throw conflict('category/has-lots', `This category still has ${lots} lot${lots === 1 ? '' : 's'}. Hide it instead, or move the lots first.`, { details: { lots } });
  }
  const [subs, types, forms] = await Promise.all([
    SubcategoryModel.deleteMany({ categorySlug: slug }),
    MineralTypeModel.deleteMany({ categorySlug: slug }),
    ProductFormModel.deleteMany({ categorySlug: slug }),
  ]);
  await CategoryModel.deleteOne({ slug });
  await audit(staff, 'Category deleted', { type: 'Category', id: slug, label: category.name }, undefined, {
    name: category.name,
    subcategories: subs.deletedCount,
    minerals: types.deletedCount,
    forms: forms.deletedCount,
  });
  return { ok: true as const, slug };
}

// ---------------------------------------------------------------------------------------------
// Subcategory groups (the customer hierarchy's middle level)
// ---------------------------------------------------------------------------------------------

export async function createSubcategory(input: { categorySlug: string; name: string; slug?: string }, staff: CatalogueStaff) {
  await requireCategory(input.categorySlug);
  const name = cleanName(input.name);
  const clash = await SubcategoryModel.findOne({ categorySlug: input.categorySlug, name: new RegExp(`^${escapeRe(name)}$`, 'i') }).lean();
  if (clash) throw conflict('subcategory/duplicate', 'That subcategory already exists in this category.');
  const slug = cleanSlug(input.slug, `${input.categorySlug}-${name}`);
  try {
    await SubcategoryModel.create({ slug, name, categorySlug: input.categorySlug, sort: 0, active: true });
  } catch (err) {
    if (dupKey(err)) throw conflict('subcategory/duplicate', 'That subcategory key is already in use.');
    throw err;
  }
  await audit(staff, 'Subcategory group created', { type: 'Subcategory', id: slug, label: name });
  return { slug, name, categorySlug: input.categorySlug, active: true };
}

export async function updateSubcategory(slug: string, patch: { name?: string; active?: boolean; sort?: number }, staff: CatalogueStaff) {
  const sub = await SubcategoryModel.findOne({ slug }).lean<ISubcategory>();
  if (!sub) throw notFound('subcategory/not-found', 'Subcategory not found');
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const name = cleanName(patch.name);
    const clash = await SubcategoryModel.findOne({ categorySlug: sub.categorySlug, slug: { $ne: slug }, name: new RegExp(`^${escapeRe(name)}$`, 'i') }).lean();
    if (clash) throw conflict('subcategory/duplicate', 'That subcategory already exists in this category.');
    set.name = name;
  }
  if (patch.active !== undefined) set.active = patch.active;
  if (patch.sort !== undefined) set.sort = patch.sort;
  if (!Object.keys(set).length) return { slug, name: sub.name, active: sub.active };
  const updated = await SubcategoryModel.findOneAndUpdate({ slug }, { $set: set }, { new: true }).lean<ISubcategory>();
  await audit(staff, 'Subcategory group updated', { type: 'Subcategory', id: slug, label: updated?.name ?? sub.name }, set, { name: sub.name, active: sub.active });
  return { slug, name: updated?.name ?? sub.name, active: updated?.active ?? sub.active };
}

export async function deleteSubcategory(slug: string, staff: CatalogueStaff) {
  const sub = await SubcategoryModel.findOne({ slug }).lean<ISubcategory>();
  if (!sub) throw notFound('subcategory/not-found', 'Subcategory not found');
  const [types, lots] = await Promise.all([MineralTypeModel.countDocuments({ subcategorySlug: slug }), lotsUnder({ subcategorySlug: slug })]);
  if (lots) throw conflict('subcategory/has-lots', `This subcategory still has ${lots} lot${lots === 1 ? '' : 's'}. Hide it instead, or move the lots first.`, { details: { lots } });
  if (types) throw conflict('subcategory/has-minerals', 'Remove or move its minerals first.', { details: { minerals: types } });
  await SubcategoryModel.deleteOne({ slug });
  await audit(staff, 'Subcategory group deleted', { type: 'Subcategory', id: slug, label: sub.name });
  return { ok: true as const, slug };
}

// ---------------------------------------------------------------------------------------------
// Minerals (the console's "subcategories")
// ---------------------------------------------------------------------------------------------

export async function createMineral(
  input: { categorySlug: string; name: string; slug?: string; subcategorySlug?: string; mineralCode?: string; sellable?: boolean },
  staff: CatalogueStaff,
) {
  await requireCategory(input.categorySlug);
  const row = await createMineralRow(input);
  await audit(staff, 'Subcategory created', { type: 'Category', id: row.slug, label: row.name }, { category: input.categorySlug });
  return { slug: row.slug, name: row.name, categorySlug: row.categorySlug, subcategorySlug: row.subcategorySlug ?? null, active: row.active };
}

/** Re-parents a mineral, its forms, and its lots under another category. */
async function moveMineral(type: IMineralType, toCategory: string) {
  await requireCategory(toCategory);
  const oldSub = type.subcategorySlug;
  const newSub = await ensureSubcategoryFor(toCategory, type.name);
  await MineralTypeModel.updateOne({ slug: type.slug }, { $set: { categorySlug: toCategory, subcategorySlug: newSub } });
  await ProductFormModel.updateMany({ mineralTypeSlug: type.slug }, { $set: { categorySlug: toCategory, subcategorySlug: newSub } });
  await ProductModel.updateMany({ typeSlug: type.slug }, { $set: { categorySlug: toCategory, subcategorySlug: newSub } });
  if (oldSub && oldSub !== newSub) {
    const [stillTypes, stillLots] = await Promise.all([
      MineralTypeModel.countDocuments({ subcategorySlug: oldSub }),
      lotsUnder({ subcategorySlug: oldSub }),
    ]);
    if (!stillTypes && !stillLots) await SubcategoryModel.deleteOne({ slug: oldSub });
  }
}

export async function updateMineral(
  slug: string,
  patch: { name?: string; active?: boolean; sellable?: boolean; mineralCode?: string; categorySlug?: string; sort?: number },
  staff: CatalogueStaff,
) {
  const type = await requireMineral(slug);
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const name = cleanName(patch.name);
    if (name !== type.name) {
      const clash = await MineralTypeModel.findOne({ slug: { $ne: slug }, name: new RegExp(`^${escapeRe(name)}$`, 'i') }).lean();
      if (clash) throw conflict('mineral/duplicate', 'A subcategory with that name already exists.');
      set.name = name;
    }
  }
  if (patch.active !== undefined) set.active = patch.active;
  if (patch.sellable !== undefined) set.sellable = patch.sellable;
  if (patch.mineralCode !== undefined) set.mineralCode = patch.mineralCode.trim().toUpperCase() || undefined;
  if (patch.sort !== undefined) set.sort = patch.sort;
  if (Object.keys(set).length) await MineralTypeModel.updateOne({ slug }, { $set: set });
  let moved = false;
  if (patch.categorySlug && patch.categorySlug !== type.categorySlug) {
    await moveMineral({ ...type, ...(set.name ? { name: String(set.name) } : {}) } as IMineralType, patch.categorySlug);
    moved = true;
  }
  if (!Object.keys(set).length && !moved) return { slug, name: type.name, categorySlug: type.categorySlug, active: type.active };
  const updated = await requireMineral(slug);
  if (set.name && type.subcategorySlug && !moved) {
    // Keep the same-named parent in step when this mineral is its only child.
    const siblings = await MineralTypeModel.countDocuments({ subcategorySlug: type.subcategorySlug });
    if (siblings === 1) await SubcategoryModel.updateOne({ slug: type.subcategorySlug }, { $set: { name: String(set.name) } });
  }
  const action = moved ? 'Subcategory moved' : set.active === undefined ? 'Subcategory updated' : set.active ? 'Subcategory on' : 'Subcategory off';
  await audit(
    staff,
    action,
    { type: 'Category', id: slug, label: updated.name },
    { ...set, ...(moved ? { categorySlug: patch.categorySlug } : {}) },
    { name: type.name, categorySlug: type.categorySlug, active: type.active },
  );
  return { slug, name: updated.name, categorySlug: updated.categorySlug, active: updated.active };
}

export async function deleteMineral(slug: string, staff: CatalogueStaff) {
  const type = await requireMineral(slug);
  const lots = await lotsUnder({ typeSlug: slug });
  if (lots) throw conflict('mineral/has-lots', `This subcategory still has ${lots} lot${lots === 1 ? '' : 's'}. Hide it instead, or move the lots first.`, { details: { lots } });
  await ProductFormModel.deleteMany({ mineralTypeSlug: slug });
  await MineralTypeModel.deleteOne({ slug });
  if (type.subcategorySlug) {
    const [remaining, subLots] = await Promise.all([
      MineralTypeModel.countDocuments({ subcategorySlug: type.subcategorySlug }),
      lotsUnder({ subcategorySlug: type.subcategorySlug }),
    ]);
    if (!remaining && !subLots) await SubcategoryModel.deleteOne({ slug: type.subcategorySlug });
  }
  await audit(staff, 'Subcategory deleted', { type: 'Category', id: slug, label: type.name });
  return { ok: true as const, slug };
}
