import type { IProduct } from '../../models/catalog.model.js';
import { mobileMoney, webMoney } from '../../common/utils/currency.js';
import { unitPriceMinorPerGram } from '../../common/utils/pricing-math.js';
import { commercialUnit, mobileQuantity, webQuantity } from '../../common/utils/quantity.js';
import { iso } from '../../common/utils/time-display.js';
import { repairCatalogImageUrl } from './hierarchy.js';

const perGram = (p: IProduct) => ({ amountMinor: unitPriceMinorPerGram(p.unitPriceMinorE4PerGram), currency: p.currency });

export function toMobileProduct(p: IProduct, typeName?: string) {
  return {
    id: p._id,
    reference: p.reference,
    name: p.name,
    type: { slug: p.typeSlug, name: typeName ?? (typeof p.attributes?.mineralTypeName === 'string' ? p.attributes.mineralTypeName : p.typeSlug) },
    categorySlug: p.categorySlug,
    subcategorySlug: p.subcategorySlug ?? null,
    productFormSlug: p.productFormSlug ?? null,
    productFormName: typeof p.attributes?.productFormName === 'string' ? p.attributes.productFormName : null,
    imageName: p.imageName ?? null,
    mineralCode: p.mineralCode,
    purity: p.purity ?? null,
    grade: p.grade ?? null,
    origin: p.origin,
    seller: p.seller,
    assured: p.assured,
    verified: p.verified,
    status: p.status,
    imageUrl: repairCatalogImageUrl(p.imageUrl),
    gradient: p.gradientFrom ? { from: p.gradientFrom, to: p.gradientTo ?? p.gradientFrom } : null,
    availability: {
      available: mobileQuantity(p.availableGrams),
      minOrder: mobileQuantity(p.minOrderGrams),
      step: mobileQuantity(p.stepGrams),
    },
    pricePerGram: mobileMoney(perGram(p)),
    createdAt: iso(p.createdAt),
  };
}

export function toMobileProductDetail(p: IProduct, typeName?: string) {
  return {
    ...toMobileProduct(p, typeName),
    description: p.description ?? null,
    attributes: p.attributes,
    media: [...p.media].sort((a, b) => a.sort - b.sort).map((m) => ({ id: m._id, kind: m.kind, url: m.url, thumbnailUrl: m.thumbnailUrl ?? null })),
    documents: p.documents.map((d) => ({ id: d._id, name: d.name, kind: d.kind })),
    passportId: p.passportId ?? null,
  };
}

export function toMobileMedia(p: IProduct) {
  return {
    data: [...p.media].sort((a, b) => a.sort - b.sort).map((m) => ({ id: m._id, kind: m.kind, url: m.url, thumbnailUrl: m.thumbnailUrl ?? null })),
  };
}

function sellingUnit(p: IProduct) {
  return commercialUnit(p.attributes?.unit) ?? 'g';
}

function listedUnitPrice(p: IProduct) {
  const list = p.attributes?.listPrice;
  if (typeof list === 'number' && list > 0) return webMoney({ amountMinor: Math.round(list * 100), currency: p.currency });
  return webMoney(perGram(p));
}

export function toWebLot(p: IProduct) {
  const unit = sellingUnit(p);
  return {
    id: p._id,
    reference: p.reference,
    title: p.name,
    mineral: { code: p.mineralCode, category: p.categorySlug, subcategory: p.subcategorySlug ?? null, type: p.typeSlug, productForm: p.productFormSlug ?? null },
    grade: p.grade ?? null,
    purity: p.purity ?? null,
    origin: { country: p.origin.country, region: p.origin.region ?? null, site: p.origin.site ?? null },
    seller: { name: p.seller.name, verified: p.seller.verified },
    verified: p.verified,
    assured: p.assured,
    status: p.status,
    available: webQuantity(p.availableGrams, unit),
    minOrder: webQuantity(p.minOrderGrams, unit),
    unitPrice: { per: unit, price: listedUnitPrice(p) },
    passportId: p.passportId ?? null,
    imageUrl: repairCatalogImageUrl(p.imageUrl),
    listPrice: typeof p.attributes?.listPrice === 'number' ? p.attributes.listPrice : null,
    priceUnit: typeof p.attributes?.unit === 'string' ? p.attributes.unit : null,
    categoryName: typeof p.attributes?.categoryName === 'string' ? p.attributes.categoryName : null,
    subcategoryName: typeof p.attributes?.subcategoryName === 'string' ? p.attributes.subcategoryName : null,
    subcategorySlug: p.subcategorySlug ?? null,
    mineralTypeName: typeof p.attributes?.mineralTypeName === 'string' ? p.attributes.mineralTypeName : null,
    mineralTypeSlug: p.typeSlug,
    productFormName: typeof p.attributes?.productFormName === 'string' ? p.attributes.productFormName : null,
    productFormSlug: p.productFormSlug ?? null,
    imageName: p.imageName ?? null,
    createdAt: iso(p.createdAt),
  };
}

export function toWebLotDetail(p: IProduct) {
  return {
    ...toWebLot(p),
    description: p.description ?? null,
    attributes: p.attributes,
    photos: [...p.media].sort((a, b) => a.sort - b.sort).filter((m) => m.kind !== 'document').map((m) => ({ id: m._id, url: m.url, thumbnailUrl: m.thumbnailUrl ?? null })),
  };
}

export const toWebProvenance = (p: IProduct) => ({
  lotId: p._id,
  events: [...p.provenance].sort((a, b) => a.at.getTime() - b.at.getTime()).map((e) => ({
    id: e._id,
    stage: e.stage,
    title: e.title,
    detail: e.detail ?? null,
    at: iso(e.at),
    location: e.location ?? null,
    hash: e.hash ?? null,
  })),
});
