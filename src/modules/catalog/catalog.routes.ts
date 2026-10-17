import { Router } from 'express';
import { ah } from '../../common/http/async-handler.js';
import { validate } from '../../common/middleware/validate.js';
import { buildCursorPage, cursorWindow } from '../../common/utils/cursor.js';
import { optionalUser } from '../auth/auth.middleware.js';
import { catalogService as svc } from './catalog.service.js';
import type { ProductQuery } from './catalog.service.js';
import { toMobileMedia, toMobileProduct, toMobileProductDetail } from './product.mapper.js';
import * as v from './catalog.validation.js';

/** Mobile catalog (/catalog/*). Mobile "product" and web "lot" are the same inventory. */
export function mobileCatalogRouter(): Router {
  const r = Router();

  const categoryNode = (c: { _id: string; slug: string; name: string; description?: string; imageUrl?: string; imageName?: string; sourceId?: string; active: boolean }) => ({
    id: c._id, slug: c.slug, name: c.name, description: c.description ?? null, imageUrl: c.imageUrl ?? null, imageName: c.imageName ?? null, sourceId: c.sourceId ?? null, isActive: c.active,
  });
  const typeNode = (t: { _id: string; slug: string; name: string; categorySlug: string; subcategorySlug?: string; imageUrl?: string; imageName?: string; sourceId?: string; active: boolean }) => ({
    id: t._id, slug: t.slug, name: t.name, categorySlug: t.categorySlug, subcategorySlug: t.subcategorySlug ?? null, imageUrl: t.imageUrl ?? null, imageName: t.imageName ?? null, sourceId: t.sourceId ?? null, isActive: t.active,
  });

  r.get('/catalog/categories', optionalUser, ah(async (_req, res) => {
    res.json({ data: (await svc.categories()).map(categoryNode) });
  }));

  r.get('/catalog/hierarchy', optionalUser, ah(async (_req, res) => {
    res.json({ categories: await svc.hierarchy() });
  }));

  r.get('/catalog/categories/:categorySlug/subcategories', optionalUser, ah(async (req, res) => {
    const rows = await svc.subcategories(String(req.params.categorySlug));
    res.json({
      data: rows.map((s) => ({
        id: s._id, slug: s.slug, name: s.name, categorySlug: s.categorySlug, imageUrl: s.imageUrl ?? null, imageName: s.imageName ?? null, sourceId: s.sourceId ?? null, isActive: s.active,
      })),
    });
  }));

  r.get('/catalog/types', optionalUser, validate({ query: v.typesQuery }), ah(async (req, res) => {
    const rows = await svc.types(req.query.category as string | undefined, req.query.subcategory as string | undefined);
    res.json({ data: rows.map(typeNode) });
  }));

  r.get('/catalog/subcategories/:subcategorySlug/types', optionalUser, validate({ params: v.subcategoryParam }), ah(async (req, res) => {
    res.json({ data: (await svc.types(undefined, String(req.params.subcategorySlug))).map(typeNode) });
  }));

  // Contract path: GET /catalog/categories/{categorySlug}/types
  r.get('/catalog/categories/:categorySlug/types', optionalUser, ah(async (req, res) => {
    res.json({ data: (await svc.types(String(req.params.categorySlug))).map(typeNode) });
  }));

  r.get('/catalog/types/:typeSlug/forms', optionalUser, validate({ params: v.typeParam }), ah(async (req, res) => {
    const rows = await svc.productForms(String(req.params.typeSlug));
    res.json({
      data: rows.map((f) => ({
        id: f._id,
        slug: f.slug,
        name: f.name,
        categorySlug: f.categorySlug,
        subcategorySlug: f.subcategorySlug,
        mineralTypeSlug: f.mineralTypeSlug,
        imageUrl: f.imageUrl ?? null,
        imageName: f.imageName ?? null,
        sourceId: f.sourceId ?? null,
        sourceSheet: f.sourceSheet,
        isActive: f.active,
      })),
    });
  }));

  r.get('/catalog/products', optionalUser, validate({ query: v.productListQuery }), ah(async (req, res) => {
    const win = cursorWindow(req.query as { limit?: unknown; cursor?: unknown });
    const { rows, total } = await svc.listProducts(req.query as ProductQuery, win.skip, win.limit);
    const names = await svc.typeNames();
    res.json(buildCursorPage(rows.map((p) => toMobileProduct(p, names.get(p.typeSlug))), total, win));
  }));

  // Contract path: GET /catalog/types/{typeSlug}/products
  r.get('/catalog/types/:typeSlug/products', optionalUser, validate({ query: v.productListQuery }), ah(async (req, res) => {
    const win = cursorWindow(req.query as { limit?: unknown; cursor?: unknown });
    const { rows, total } = await svc.listProducts({ ...(req.query as ProductQuery), type: String(req.params.typeSlug) }, win.skip, win.limit);
    const names = await svc.typeNames();
    res.json(buildCursorPage(rows.map((p) => toMobileProduct(p, names.get(p.typeSlug))), total, win));
  }));

  r.get('/catalog/products/:productId', optionalUser, validate({ params: v.productIdParam }), ah(async (req, res) => {
    const p = await svc.getProduct(String(req.params.productId));
    const names = await svc.typeNames();
    res.json(toMobileProductDetail(p, names.get(p.typeSlug)));
  }));

  r.get('/catalog/products/:productId/media', optionalUser, validate({ params: v.productIdParam }), ah(async (req, res) => {
    res.json(toMobileMedia(await svc.getProduct(String(req.params.productId))));
  }));

  r.get('/catalog/search', optionalUser, validate({ query: v.searchQuery }), ah(async (req, res) => {
    const limit = Number(req.query.limit ?? 10);
    const { rows } = await svc.listProducts({ q: String(req.query.q) }, 0, limit);
    const names = await svc.typeNames();
    res.json({ data: rows.map((p) => toMobileProduct(p, names.get(p.typeSlug))) });
  }));

  r.get('/catalog/filters', optionalUser, ah(async (_req, res) => {
    const f = await svc.filters();
    res.json({
      categories: f.categories.map((c) => ({ slug: c.slug, name: c.name })),
      subcategories: f.subcategories.map((s) => ({ slug: s.slug, name: s.name, categorySlug: s.categorySlug })),
      types: f.types.map((t) => ({ slug: t.slug, name: t.name, categorySlug: t.categorySlug, subcategorySlug: t.subcategorySlug ?? null })),
      productForms: f.forms.map((form) => ({ slug: form.slug, name: form.name, mineralTypeSlug: form.mineralTypeSlug, imageUrl: form.imageUrl ?? null, imageName: form.imageName ?? null })),
      origins: f.countries,
      sort: ['newest', 'price_asc', 'price_desc'],
    });
  }));

  return r;
}
