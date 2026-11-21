import { Router } from 'express';
import { z } from 'zod';
import { notFound } from '../../common/errors/app-error.js';
import { validate } from '../../common/middleware/validate.js';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { ProductModel } from '../../models/catalog.model.js';
import { optionalUser } from '../auth/auth.middleware.js';
import { catalogService as svc } from './catalog.service.js';
import { documentTypeParam, resolveProductDocument, type ProductDocumentType } from './product-documents.js';
import { toMobileProduct, toMobileProductDetail } from './product.mapper.js';

const listQuery = z.object({
  mineral: z.string().max(80).optional(),
  category: z.string().max(80).optional(),
  form: z.string().max(80).optional(),
  labTested: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  q: z.string().max(80).optional(),
  sort: z.enum(['featured', 'available_desc', 'available_asc', 'name']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

export function createV2CatalogueRouter(): Router {
  const r = Router();

  r.get(
    '/categories',
    optionalUser,
    asyncHandler(async (_req, res) => {
      const tree = await svc.hierarchy();
      const items = await Promise.all(
        tree.map(async (c) => {
          const minerals = c.subcategories.flatMap((sub) =>
            sub.mineralTypes.map((m) => ({ slug: m.slug, name: m.name })),
          );
          const withCounts = await Promise.all(
            minerals.map(async (m) => ({
              ...m,
              lotCount: await ProductModel.countDocuments({
                typeSlug: m.slug,
                status: { $in: ['active', 'sold'] },
              }),
            })),
          );
          return {
            slug: c.slug,
            name: c.name,
            image: c.imageUrl ? { url: c.imageUrl, name: c.imageName ?? null } : null,
            minerals: withCounts,
          };
        }),
      );
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.status(200).json({ items });
    }),
  );

  r.get(
    '/products',
    optionalUser,
    validate({ query: listQuery }),
    asyncHandler(async (req, res) => {
      const q = req.query as z.infer<typeof listQuery>;
      const sortMap = {
        featured: 'newest' as const,
        available_desc: 'newest' as const,
        available_asc: 'price_asc' as const,
        name: 'newest' as const,
      };
      const limit = q.limit ?? 24;
      const skip = q.cursor ? Number.parseInt(q.cursor, 10) || 0 : 0;
      const { rows, total } = await svc.listProducts(
        {
          category: q.category,
          type: q.mineral,
          productForm: q.form,
          q: q.q,
          verified: q.labTested,
          sort: sortMap[q.sort ?? 'featured'],
        },
        skip,
        limit,
      );
      const names = await svc.typeNames();
      const items = rows.map((p) => {
        const card = toMobileProduct(p, names.get(p.typeSlug));
        return {
          ...card,
          productRef: p.reference,
          soldOut: (p.availableGrams ?? 0) <= 0,
        };
      });
      const next = skip + items.length < total ? String(skip + items.length) : null;
      res.status(200).json({ items, nextCursor: next, total });
    }),
  );

  r.get(
    '/products/:ref',
    optionalUser,
    asyncHandler(async (req, res) => {
      const ref = String(req.params.ref);
      const p =
        (await ProductModel.findOne({ reference: ref }).lean()) ??
        (await ProductModel.findById(ref).lean());
      if (!p || p.status === 'draft') {
        throw notFound('catalogue/not-found', 'Product not found');
      }
      const names = await svc.typeNames();
      const detail = toMobileProductDetail(p, names.get(p.typeSlug));
      res.status(200).json({ ...detail, productRef: p.reference });
    }),
  );

  r.get(
    '/products/:ref/documents/:type',
    optionalUser,
    validate({ params: z.object({ ref: z.string().min(1).max(120), type: documentTypeParam }) }),
    asyncHandler(async (req, res) => {
      const doc = await resolveProductDocument(String(req.params.ref), req.params.type as ProductDocumentType);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(doc);
    }),
  );

  return r;
}
