import { z } from 'zod';
import { notFound } from '../../common/errors/app-error.js';
import { FileModel } from '../../models/file.model.js';
import { ProductModel, type IProduct } from '../../models/catalog.model.js';
import { uploadsService } from '../uploads/uploads.service.js';

/** Public catalogue document types (doc 07 `GET /v2/catalogue/products/{ref}/documents/{type}`). */
export const PRODUCT_DOCUMENT_TYPES = ['lot_test_report', 'certificate_of_analysis', 'origin_declaration'] as const;
export type ProductDocumentType = (typeof PRODUCT_DOCUMENT_TYPES)[number];

/** Normalised alias (lowercase, non-alphanumerics → `_`) → canonical type. */
const ALIASES: Record<string, ProductDocumentType> = {
  lot_test_report: 'lot_test_report',
  test_report: 'lot_test_report',
  lab_report: 'lot_test_report',
  lab_test_report: 'lot_test_report',
  lot_report: 'lot_test_report',
  certificate_of_analysis: 'certificate_of_analysis',
  coa: 'certificate_of_analysis',
  analysis_certificate: 'certificate_of_analysis',
  origin_declaration: 'origin_declaration',
  declaration_of_origin: 'origin_declaration',
  origin: 'origin_declaration',
  origin_certificate: 'origin_declaration',
};

const normalizeToken = (raw: string): string =>
  raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/** Maps a stored `documents[].kind` (or request alias) to a canonical type, or null. */
export function canonicalDocumentType(raw: string | undefined | null): ProductDocumentType | null {
  if (!raw) return null;
  return ALIASES[normalizeToken(raw)] ?? null;
}

/** `:type` path param: accepts canonical names and known aliases, rejects everything else (422). */
export const documentTypeParam = z
  .string()
  .max(64)
  .transform((v) => canonicalDocumentType(v) ?? '__invalid__')
  .pipe(z.enum(PRODUCT_DOCUMENT_TYPES, { errorMap: () => ({ message: `Must be one of: ${PRODUCT_DOCUMENT_TYPES.join(', ')}` }) }));

/** Same visibility rules as product detail, tightened for documents: only listed lots expose them. */
const DOCUMENT_VISIBLE_STATUSES: ReadonlySet<string> = new Set(['active', 'sold']);

const isHttpUrl = (value: string): boolean => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
};

const SIGNED_TTL_SECONDS = 300;

export type ProductDocumentResponse = {
  type: ProductDocumentType;
  number: string;
  name: string;
  contentType: string | null;
  available: true;
  url: string;
  expiresAt: string | null;
  bytes?: number;
};

const notAvailable = () => notFound('document/not-available', 'Document is not available for this lot.');

export async function resolveProductDocument(ref: string, type: ProductDocumentType): Promise<ProductDocumentResponse> {
  const product =
    (await ProductModel.findOne({ reference: ref }).lean<IProduct>()) ??
    (await ProductModel.findById(ref).lean<IProduct>());
  // Unknown, draft, withdrawn (archived) -> indistinguishable 404 so nothing leaks.
  if (!product || !DOCUMENT_VISIBLE_STATUSES.has(product.status)) throw notAvailable();

  const matches = (product.documents ?? []).filter((d) => d.visible !== false && canonicalDocumentType(d.kind) === type);
  // Prefer stored files over external links; keep insertion order within each group.
  const ordered = [...matches.filter((d) => d.fileId), ...matches.filter((d) => !d.fileId)];

  const number =
    type === 'origin_declaration' ? undefined : product.lab?.certificateNo?.trim() || undefined;

  for (const doc of ordered) {
    if (doc.fileId) {
      const file = await FileModel.findOne({ _id: doc.fileId, deletedAt: null }).lean();
      if (!file || !(file.bytes > 0) || file.scan?.status !== 'clean') continue;
      const signed = uploadsService.signed(doc.fileId, SIGNED_TTL_SECONDS);
      return {
        type,
        number: number ?? doc.name,
        name: doc.name,
        contentType: doc.contentType ?? file.contentType ?? null,
        available: true,
        url: signed.url,
        expiresAt: signed.expiresAt.toISOString(),
        bytes: file.bytes ?? doc.bytes,
      };
    }
    if (doc.url && isHttpUrl(doc.url)) {
      return {
        type,
        number: number ?? doc.name,
        name: doc.name,
        contentType: doc.contentType ?? null,
        available: true,
        url: doc.url,
        expiresAt: null,
        ...(doc.bytes !== undefined ? { bytes: doc.bytes } : {}),
      };
    }
  }
  throw notAvailable();
}
