import { Router } from 'express';
import { z } from 'zod';
import { notFound } from '../../common/errors/app-error.js';
import { validate } from '../../common/middleware/validate.js';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { ProductModel } from '../../models/catalog.model.js';
import { optionalUser } from '../auth/auth.middleware.js';
import { catalogService as svc } from './catalog.service.js';
import { documentTypeParam, resolveProductDocument, type ProductDocumentType } from './product-documents.js';
import { catalogueAvailabilityFlags } from './product-availability.js';
import { httpCatalogImage, pickCatalogImage } from './hierarchy.js';
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
          const bySlug = new Map<string, { slug: string; name: string; forms: typeof c.subcategories[number]['mineralTypes'][number]['productForms'] }>();
          for (const sub of c.subcategories) {
            for (const mineral of sub.mineralTypes) {
              if (mineral.isActive === false) continue;
              const existing = bySlug.get(mineral.slug);
              if (existing) {
                existing.forms.push(...mineral.productForms);
                continue;
              }
              bySlug.set(mineral.slug, { slug: mineral.slug, name: mineral.name, forms: [...mineral.productForms] });
            }
          }
          const minerals = await Promise.all(
            [...bySlug.values()].map(async (mineral) => {
              const type = c.subcategories.flatMap((sub) => sub.mineralTypes).find((row) => row.slug === mineral.slug);
              const image = pickCatalogImage(mineral.name, type?.imageUrl, type?.imageName, mineral.forms);
              return {
                slug: mineral.slug,
                name: mineral.name,
                image,
                lotCount: await ProductModel.countDocuments({
                  typeSlug: mineral.slug,
                  status: { $in: ['active', 'sold'] },
                }),
              };
            }),
          );
          const storedCategory = httpCatalogImage(c.imageUrl);
          const categoryImage = storedCategory
            ? { url: storedCategory, name: c.imageName ?? null }
            : minerals.find((mineral) => mineral.image)?.image ?? null;
          return {
            slug: c.slug,
            name: c.name,
            image: categoryImage,
            minerals,
          };
        }),
      );
      res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
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
      const [names, forms] = await Promise.all([svc.typeNames(), svc.productForms()]);
      const formImage = new Map(forms.map((form) => [form.slug, form.imageUrl]));
      const items = rows.map((p) => {
        const card = toMobileProduct(p, names.get(p.typeSlug), p.productFormSlug ? formImage.get(p.productFormSlug) : null);
        return {
          ...card,
          productRef: p.reference,
          ...catalogueAvailabilityFlags(p),
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
      const [names, forms] = await Promise.all([svc.typeNames(), svc.productForms()]);
      const formUrl = forms.find((form) => form.slug === p.productFormSlug)?.imageUrl;
      const detail = toMobileProductDetail(p, names.get(p.typeSlug), formUrl);
      res.status(200).json({ ...detail, productRef: p.reference, ...catalogueAvailabilityFlags(p) });
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
