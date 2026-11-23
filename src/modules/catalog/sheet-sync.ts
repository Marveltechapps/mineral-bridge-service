import { logger } from '../../config/logger.js';
import { quotedPriceToE4PerGram } from '../../common/utils/pricing-math.js';
import { CategoryModel, MineralTypeModel, ProductFormModel, ProductModel, SubcategoryModel } from '../../models/catalog.model.js';
import { Mineral, MineralCategory } from '../reference/reference.model.js';
import { hierarchyErrors, imageMatchesSource, imageNameFromUrl } from './hierarchy.js';

export interface CatalogSyncIssue {
  sourceRow: number;
  field?: string;
  message: string;
}

export interface CatalogSyncRowReport {
  sourceRow: number;
  sourceKey: string | null;
  mapped: {
    category: string;
    subcategory: string;
    mineralType: string;
    productForm: string;
    name: string;
    grade: string;
    unit: string;
    price: number | null;
    imageUrl: string | null;
    imageName: string | null;
  } | null;
  status: 'imported' | 'skipped' | 'invalid';
  write?: 'created' | 'updated' | 'unchanged';
  errors: string[];
  warnings: string[];
  image?: { url: string; ok: boolean; contentType: string | null; detail: string; matchesSource: boolean };
}

export interface CatalogSyncReport {
  fetchedAt: string;
  source: string;
  headers: string[];
  imported: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  invalid: number;
  rejected: number;
  duplicates: number;
  unpublished: number;
  accessError?: string;
  rows: CatalogSyncRowReport[];
}

const HEADER_ALIASES: Record<string, string[]> = {
  category: ['category', 'mineral category', 'cat'],
  subcategory: ['subcategory', 'sub category', 'sub-category', 'sub category name', 'category & sub category name', 'category & subcategory name'],
  mineralType: ['mineral type', 'mineraltype', 'type name'],
  productForm: ['product form', 'product form / variety', 'variety', 'form'],
  name: ['mineral', 'mineral name', 'name', 'product'],
  imageName: ['image name', 'image filename', 'filename'],
  description: ['product description', 'description'],
  grade: ['grade', 'specification', 'specifications', 'spec', 'purity'],
  unit: ['unit', 'units'],
  price: ['price', 'unit price', 'price usd', 'sell price', 'buyer price'],
  image: ['image', 'image url', 'image_url', 'photo', 'picture', 'image link', 'primary image'],
  origin: ['origin', 'country', 'country of origin'],
  status: ['status', 'publication', 'published', 'visibility'],
  id: ['id', 'sku', 'code', 'mineral id', 'source id', 'source_id'],
};

const PUBLISHED = new Set(['', 'published', 'active', 'live', 'yes', 'true', '1']);

export type NameSource = 'column' | 'subcategory' | 'mineral-name';

/**
 * Column mapping for the hierarchy. Mineral Type and Product Form are taken from
 * their own columns when those columns exist. They are never inferred by
 * trimming or matching the mineral name.
 */
export function classifyCatalogNames(input: {
  category: string;
  subcategory: string;
  mineralName: string;
  mineralTypeColumn: string;
  productFormColumn: string;
}): {
  mineralType: string;
  productForm: string;
  mineralTypeSource: NameSource;
  productFormSource: NameSource;
  warnings: string[];
} {
  const mineralTypeColumn = input.mineralTypeColumn.trim();
  const productFormColumn = input.productFormColumn.trim();
  const warnings: string[] = [];
  const mineralType = mineralTypeColumn || input.subcategory;
  const productForm = productFormColumn || input.mineralName;
  if (!mineralTypeColumn) warnings.push('mineral type equals Sub Category Name because the sheet has no Mineral Type column');
  if (!productFormColumn) warnings.push('product form equals Mineral Name because the sheet has no Product Form column');
  if (/[&/]/.test(input.subcategory)) {
    warnings.push('subcategory name may cover more than one mineral; mineral type was not split');
  }
  return {
    mineralType,
    productForm,
    mineralTypeSource: mineralTypeColumn ? 'column' : 'subcategory',
    productFormSource: productFormColumn ? 'column' : 'mineral-name',
    warnings,
  };
}

export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function headerIndex(headers: string[]): Record<string, number> {
  const normalized = headers.map((h) => h.trim().toLowerCase());
  const index: Record<string, number> = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const at = normalized.findIndex((h) => aliases.includes(h));
    if (at >= 0) index[key] = at;
  }
  return index;
}

function cell(row: string[], index: Record<string, number>, key: string): string {
  const at = index[key];
  if (at === undefined) return '';
  return (row[at] ?? '').trim();
}

/** Sheet price is major currency units per quoted unit. Storage is minor-units × 10^4 per gram. */
export function sheetPriceToE4PerGram(price: number, unit: string): number {
  return quotedPriceToE4PerGram(price, unit);
}

function parsePrice(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed || !/\d/.test(trimmed)) return null;
  const n = Number(trimmed.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export class CatalogAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogAccessError';
  }
}

export async function fetchCatalogCsv(input: {
  sheetId?: string;
  gid?: string;
  csvUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ csv: string; source: string }> {
  const source =
    input.csvUrl ||
    (input.sheetId
      ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(input.sheetId)}/export?format=csv&gid=${encodeURIComponent(input.gid || '0')}`
      : '');
  if (!source) throw new CatalogAccessError('CATALOG_SHEET_ID or CATALOG_SHEET_CSV_URL is not configured');
  const fetchImpl = input.fetchImpl ?? fetch;
  const res = await fetchImpl(source, { redirect: 'follow' });
  const body = await res.text();
  const contentType = res.headers.get('content-type') ?? '';
  const looksLikeLogin = /accounts\.google\.com|Sign in/i.test(body) && /<!doctype html|<html/i.test(body);
  if (!res.ok || looksLikeLogin || /text\/html/i.test(contentType)) {
    throw new CatalogAccessError(
      `Spreadsheet is not readable (${res.status}). Share it as "anyone with the link can view", or set CATALOG_SHEET_CSV_URL to an exported CSV the server can fetch. No catalog rows were changed.`,
    );
  }
  return { csv: body, source };
}

export interface ParsedCatalog {
  headers: string[];
  missingHeaders: string[];
  rows: CatalogSyncRowReport[];
  accepted: Array<{
    sourceRow: number;
    sourceKey: string;
    category: string;
    categorySlug: string;
    subcategory: string;
    subcategorySlug: string;
    mineralType: string;
    mineralTypeSlug: string;
    mineralTypeSource: NameSource;
    productForm: string;
    productFormSlug: string;
    productFormSource: NameSource;
    name: string;
    grade: string;
    unit: string;
    price: number | null;
    imageUrl: string | null;
    imageName: string | null;
    description: string;
    origin: string;
    mineralId: string;
    sourceId: string;
    warnings: string[];
  }>;
}

export function parseCatalogCsv(csv: string): ParsedCatalog {
  const table = parseCsv(csv);
  const headers = (table[0] ?? []).map((h) => h.trim());
  const index = headerIndex(headers);
  const missingHeaders = ['category', 'name'].filter((key) => index[key] === undefined);
  const rows: CatalogSyncRowReport[] = [];
  const accepted: ParsedCatalog['accepted'] = [];
  const seenIds = new Set<string>();
  if (missingHeaders.length) {
    return { headers, missingHeaders, rows, accepted };
  }
  table.slice(1).forEach((raw, offset) => {
    const sourceRow = offset + 2;
    const category = cell(raw, index, 'category');
    const subcategory = cell(raw, index, 'subcategory') || category;
    const name = cell(raw, index, 'name');
    const description = cell(raw, index, 'description');
    const grade = cell(raw, index, 'grade');
    const unit = cell(raw, index, 'unit') || 'kg';
    const price = parsePrice(cell(raw, index, 'price'));
    const imageUrl = cell(raw, index, 'image');
    const imageName = cell(raw, index, 'imageName') || imageNameFromUrl(imageUrl) || '';
    const status = cell(raw, index, 'status').toLowerCase();
    const sourceId = cell(raw, index, 'id');
    const classified = classifyCatalogNames({
      category,
      subcategory,
      mineralName: name,
      mineralTypeColumn: cell(raw, index, 'mineralType'),
      productFormColumn: cell(raw, index, 'productForm'),
    });
    const preview = {
      category,
      subcategory,
      mineralType: classified.mineralType,
      productForm: classified.productForm,
      name,
      grade,
      unit,
      price,
      imageUrl: imageUrl || null,
      imageName: imageName || null,
    };
    if (!name) {
      rows.push({
        sourceRow,
        sourceKey: sourceId ? slugify(sourceId) : null,
        mapped: preview,
        status: 'skipped',
        errors: [sourceId ? 'no mineral name' : 'section header'],
        warnings: [],
      });
      return;
    }
    const errors: string[] = [];
    if (!category) errors.push('missing category');
    if (!name) errors.push('missing mineral name');
    if (!classified.mineralType) errors.push('missing mineral type');
    if (!classified.productForm) errors.push('missing product form');
    if (cell(raw, index, 'price') && price === null) errors.push('invalid price');
    if (imageUrl && !/^https?:\/\//i.test(imageUrl)) errors.push('image is not an http(s) URL');
    if (sourceId && seenIds.has(sourceId.toLowerCase())) errors.push('duplicate mineral id');
    const sourceKey = slugify(sourceId || `${category}|${subcategory}|${classified.mineralType}|${classified.productForm}|${name}|${grade}`);
    if (!PUBLISHED.has(status)) {
      rows.push({
        sourceRow,
        sourceKey,
        mapped: preview,
        status: 'skipped',
        errors: [`status "${status}" is not published`],
        warnings: classified.warnings,
      });
      return;
    }
    if (errors.length || !sourceKey) {
      rows.push({
        sourceRow,
        sourceKey: sourceKey || null,
        mapped: null,
        status: 'invalid',
        errors: errors.length ? errors : ['could not build a stable source key'],
        warnings: classified.warnings,
      });
      return;
    }
    const categorySlug = slugify(category);
    const subcategorySlug = slugify(`${category}-${subcategory}`);
    const mineralTypeSlug = slugify(`${category}-${classified.mineralType}`);
    const productFormSlug = slugify(`${mineralTypeSlug}-${classified.productForm}`);
    const storedImage = /^https?:\/\//i.test(imageUrl) ? imageUrl : null;
    const item = {
      sourceRow,
      sourceKey,
      category,
      categorySlug,
      subcategory,
      subcategorySlug,
      mineralType: classified.mineralType,
      mineralTypeSlug,
      mineralTypeSource: classified.mineralTypeSource,
      productForm: classified.productForm,
      productFormSlug,
      productFormSource: classified.productFormSource,
      name,
      grade,
      unit,
      price,
      imageUrl: storedImage,
      imageName: storedImage ? imageName || imageNameFromUrl(storedImage) : null,
      description,
      origin: cell(raw, index, 'origin').toUpperCase().slice(0, 2) || 'unspecified',
      mineralId: `SHEET-${sourceKey}`.slice(0, 64),
      sourceId,
      warnings: classified.warnings,
    };
    const linkErrors = hierarchyErrors({
      categorySlug,
      subcategorySlug,
      subcategoryCategorySlug: categorySlug,
      mineralTypeSlug,
      mineralTypeCategorySlug: categorySlug,
      mineralTypeSubcategorySlug: subcategorySlug,
      productFormCategorySlug: categorySlug,
      productFormSubcategorySlug: subcategorySlug,
      productFormMineralTypeSlug: mineralTypeSlug,
    });
    if (linkErrors.length) {
      rows.push({
        sourceRow,
        sourceKey,
        mapped: null,
        status: 'invalid',
        errors: linkErrors,
        warnings: classified.warnings,
      });
      return;
    }
    if (sourceId) seenIds.add(sourceId.toLowerCase());
    accepted.push(item);
    rows.push({
      sourceRow,
      sourceKey,
      mapped: { ...preview, imageUrl: item.imageUrl, imageName: item.imageName },
      status: 'imported',
      errors: [],
      warnings: classified.warnings,
    });
  });
  return { headers, missingHeaders, rows, accepted };
}

async function checkImage(url: string, sourceId: string, fetchImpl: typeof fetch): Promise<CatalogSyncRowReport['image']> {
  const matchesSource = imageMatchesSource(url, sourceId);
  try {
    const res = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    const contentType = res.headers.get('content-type');
    const ok = res.ok && (contentType ? contentType.startsWith('image/') || contentType.startsWith('application/octet-stream') : true);
    return { url, ok, contentType, detail: ok ? 'reachable' : `HTTP ${res.status}`, matchesSource };
  } catch {
    return { url, ok: false, contentType: null, detail: 'request failed', matchesSource };
  }
}

/**
 * Idempotent sync. A failed or incomplete fetch changes nothing.
 * Rows already imported from the sheet and absent from a successful file are
 * unpublished (not deleted). Manual records without `attributes.sourceSheet` stay.
 */
export async function syncCatalogFromCsv(
  csv: string,
  source: string,
  fetchImpl: typeof fetch = fetch,
  options?: { checkImages?: boolean },
): Promise<CatalogSyncReport> {
  const parsed = parseCatalogCsv(csv);
  const report: CatalogSyncReport = {
    fetchedAt: new Date().toISOString(),
    source,
    headers: parsed.headers,
    imported: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    invalid: parsed.rows.filter((r) => r.status === 'invalid').length,
    rejected: parsed.rows.filter((r) => r.status === 'invalid').length,
    duplicates: parsed.rows.filter((r) => r.errors.some((e) => e.startsWith('duplicate'))).length,
    unpublished: 0,
    rows: parsed.rows,
  };
  if (parsed.missingHeaders.length) {
    report.accessError = `Spreadsheet is missing required columns: ${parsed.missingHeaders.join(', ')}. Found headers: ${parsed.headers.join(', ') || '(none)'}. No records were changed.`;
    return report;
  }
  if (parsed.accepted.length === 0 && parsed.rows.length === 0) {
    report.accessError = 'Spreadsheet has no data rows. Existing catalog records were left unchanged.';
    return report;
  }

  const seenCategories = new Map<string, { name: string; sort: number }>();
  const seenKeys = new Set<string>();
  for (const row of parsed.accepted) {
    seenCategories.set(row.categorySlug, { name: row.category, sort: seenCategories.size });
    seenKeys.add(row.sourceKey);
    const image = options?.checkImages === false || !row.imageUrl ? undefined : await checkImage(row.imageUrl, row.sourceId, fetchImpl);
    const reportRow = report.rows.find((r) => r.sourceRow === row.sourceRow && r.sourceKey === row.sourceKey);
    if (reportRow && image) {
      reportRow.image = image;
      if (!image.ok) reportRow.errors.push(`image unavailable: ${image.detail}`);
      if (row.sourceId && !image.matchesSource) reportRow.errors.push('image url does not contain the mineral id');
    }
    const imageUrl = row.imageUrl ?? undefined;
    await MineralCategory.updateOne(
      { categoryId: `SHEET-${row.categorySlug}` },
      { $set: { name: row.category, position: seenCategories.get(row.categorySlug)!.sort, active: true } },
      { upsert: true },
    );
    await Mineral.updateOne(
      { mineralId: row.mineralId },
      {
        $set: {
          name: row.name,
          categoryId: `SHEET-${row.categorySlug}`,
          subcategorySlug: row.subcategorySlug,
          mineralTypeSlug: row.mineralTypeSlug,
          productFormSlug: row.productFormSlug,
          grades: row.grade ? [row.grade] : [],
          units: [row.unit],
          active: true,
        },
      },
      { upsert: true },
    );
    await CategoryModel.updateOne(
      { slug: row.categorySlug },
      {
        $set: {
          name: row.category,
          sort: seenCategories.get(row.categorySlug)!.sort,
          active: true,
          sourceId: `SHEET-${row.categorySlug}`,
        },
      },
      { upsert: true },
    );
    await SubcategoryModel.updateOne(
      { slug: row.subcategorySlug },
      {
        $set: {
          name: row.subcategory,
          categorySlug: row.categorySlug,
          active: true,
          sourceId: `SHEET-${row.subcategorySlug}`,
        },
      },
      { upsert: true },
    );
    await MineralTypeModel.updateOne(
      { slug: row.mineralTypeSlug },
      {
        $set: {
          categorySlug: row.categorySlug,
          subcategorySlug: row.subcategorySlug,
          name: row.mineralType,
          active: true,
          sellable: true,
          sourceId: `SHEET-${row.mineralTypeSlug}`,
        },
      },
      { upsert: true },
    );
    await ProductFormModel.updateOne(
      { slug: row.productFormSlug },
      {
        $set: {
          name: row.productForm,
          categorySlug: row.categorySlug,
          subcategorySlug: row.subcategorySlug,
          mineralTypeSlug: row.mineralTypeSlug,
          imageUrl,
          imageName: row.imageName ?? undefined,
          sourceId: row.sourceId || row.sourceKey,
          sourceSheet: true,
          active: true,
        },
      },
      { upsert: true },
    );
    const hasPrice = row.price != null;
    const written = await ProductModel.updateOne(
      { 'attributes.sourceKey': row.sourceKey },
      {
        $set: {
          name: row.name,
          typeSlug: row.mineralTypeSlug,
          categorySlug: row.categorySlug,
          subcategorySlug: row.subcategorySlug,
          productFormSlug: row.productFormSlug,
          mineralCode: row.mineralId,
          grade: row.grade || undefined,
          description: row.description || undefined,
          origin: { country: row.origin === 'unspecified' ? 'unspecified' : row.origin },
          status: 'active',
          currency: 'USD',
          ...(hasPrice ? { unitPriceMinorE4PerGram: sheetPriceToE4PerGram(row.price as number, row.unit) } : {}),
          imageUrl,
          imageName: row.imageName ?? undefined,
          attributes: {
            sourceSheet: true,
            sourceKey: row.sourceKey,
            sourceId: row.sourceId,
            unit: row.unit,
            ...(hasPrice ? { listPrice: row.price } : {}),
            categoryName: row.category,
            subcategoryName: row.subcategory,
            mineralTypeName: row.mineralType,
            productFormName: row.productForm,
            mineralTypeSource: row.mineralTypeSource,
            productFormSource: row.productFormSource,
          },
        },
        $setOnInsert: {
          reference: `MBV-SHEET-${row.sourceKey}`.slice(0, 64),
          availableGrams: 0,
          ...(hasPrice ? {} : { unitPriceMinorE4PerGram: 0 }),
        },
      },
      { upsert: true },
    );
    const write = written.upsertedCount ? 'created' : written.modifiedCount ? 'updated' : 'unchanged';
    if (reportRow) reportRow.write = write;
    if (write === 'created') report.created += 1;
    else if (write === 'updated') report.updated += 1;
    else report.unchanged += 1;
    report.imported += 1;
  }
  report.skipped = report.rows.filter((r) => r.status === 'skipped').length;

  if (seenKeys.size > 0) {
    const stale = await ProductModel.find({ 'attributes.sourceSheet': true, status: 'active' }).select('_id attributes').lean();
    const drop = stale.filter((p) => !seenKeys.has(String((p.attributes as { sourceKey?: string }).sourceKey ?? '')));
    if (drop.length) {
      await ProductModel.updateMany({ _id: { $in: drop.map((p) => p._id) } }, { $set: { status: 'withdrawn' } });
      report.unpublished = drop.length;
    }
  }
  logger.info({ imported: report.imported, invalid: report.invalid, unpublished: report.unpublished }, 'catalog sheet sync finished');
  return report;
}
