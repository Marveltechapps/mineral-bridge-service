import { Router } from 'express';
import { ah } from '../../common/http/async-handler.js';
import { mobileMoney, webMoney } from '../../common/utils/currency.js';
import { unitPriceMinorPerGram } from '../../common/utils/pricing-math.js';
import { iso } from '../../common/utils/time-display.js';
import { ProductModel } from '../../models/catalog.model.js';
import { optionalUser } from '../auth/auth.middleware.js';
import { catalogService } from '../catalog/catalog.service.js';
import type { ReferenceKind } from '../../models/reference.model.js';
import { contentService as svc } from './content.service.js';

const cache = (res: { setHeader(k: string, v: string): void }, s = 300) => res.setHeader('Cache-Control', `public, max-age=${s}`);

/** Mobile: intro, account tiers, rates. */
export function mobileContentRouter(): Router {
  const r = Router();
  r.get('/content/intro', ah(async (_req, res) => { cache(res); res.json((await svc.block('intro')).data); }));
  r.get('/content/account-tiers', ah(async (_req, res) => { cache(res); res.json((await svc.block('account-tiers')).data); }));
  const ratesHandler = ah(async (_req: unknown, res: { setHeader(k: string, v: string): void; json(b: unknown): void }) => {
    const rows = await svc.rates();
    res.json({
      data: rows.map((x) => ({
        mineralCode: x.mineralCode,
        pricePerGram: mobileMoney({ amountMinor: unitPriceMinorPerGram(x.unitPriceMinorE4PerGram), currency: x.currency }),
        change24hPct: x.change24hBps / 100,
        asOf: iso(x.asOf),
        source: x.source,
      })),
    });
  });
  r.get('/rates', optionalUser, ratesHandler);
  // Contract path: GET /reference/rates
  r.get('/reference/rates', optionalUser, ratesHandler);
  return r;
}

const WEB_REFERENCE: [string, ReferenceKind][] = [
  ['units', 'unit'],
  ['countries', 'country'],
  ['incoterms', 'incoterm'],
  ['id-types', 'id-type'],
  ['banks', 'bank'],
  ['payout-networks', 'payout-network'],
];

/** Web: eight cacheable reference lists + generic content blocks. */
export function webReferenceRouter(): Router {
  const r = Router();
  // Catalog categories and minerals come from the sheet-backed collections.
  // An empty collection stays empty — reference defaults are not mineral records.
  r.get('/reference/categories', ah(async (_req, res) => {
    cache(res, 60);
    const [cats, subs, tree] = await Promise.all([
      catalogService.categories(),
      catalogService.subcategories(),
      catalogService.hierarchy(),
    ]);
    const covers = new Map(tree.map((category) => [category.slug, category.imageUrl]));
    const subCovers = new Map(tree.flatMap((category) => category.subcategories.map((sub) => [sub.slug, sub.imageUrl] as const)));
    const counts = await ProductModel.aggregate<{ _id: string; count: number }>([
      { $match: { status: 'active' } },
      { $group: { _id: '$categorySlug', count: { $sum: 1 } } },
    ]);
    const bySlug = new Map(counts.map((row) => [row._id, row.count]));
    res.json({
      items: cats.map((c) => {
        const children = subs.filter((s) => s.categorySlug === c.slug);
        const names = children.map((s) => s.name);
        return {
          key: c.slug,
          name: c.name,
          shortName: c.name,
          subCategories: names,
          subcategories: children.map((s) => ({ slug: s.slug, name: s.name, imageUrl: subCovers.get(s.slug) ?? s.imageUrl ?? null, imageName: s.imageName ?? null })),
          featuredTypes: names,
          imageUrl: covers.get(c.slug) ?? c.imageUrl ?? null,
          imageName: c.imageName ?? null,
          lotCount: bySlug.get(c.slug) ?? 0,
        };
      }),
    });
  }));
  r.get('/reference/minerals', ah(async (_req, res) => {
    cache(res, 60);
    const [types, cats] = await Promise.all([catalogService.types(), catalogService.categories()]);
    const names = new Map(cats.map((c) => [c.slug, c.name]));
    res.json({
      items: types.map((t) => ({
        id: t.slug,
        name: t.name,
        categoryKey: t.categorySlug,
        categoryName: names.get(t.categorySlug) ?? t.categorySlug,
        defaultUnit: 'kg',
      })),
      allowsOther: true,
    });
  }));
  r.get('/reference/hierarchy', ah(async (_req, res) => {
    cache(res, 60);
    res.json({ categories: await catalogService.hierarchy() });
  }));
  r.get('/reference/categories/:categorySlug/subcategories', ah(async (req, res) => {
    cache(res, 60);
    const rows = await catalogService.subcategories(String(req.params.categorySlug));
    res.json({ items: rows.map((s) => ({ slug: s.slug, name: s.name, categorySlug: s.categorySlug, imageUrl: s.imageUrl ?? null, imageName: s.imageName ?? null, isActive: s.active })) });
  }));
  r.get('/reference/subcategories/:subcategorySlug/types', ah(async (req, res) => {
    cache(res, 60);
    const rows = await catalogService.types(undefined, String(req.params.subcategorySlug));
    res.json({ items: rows.map((t) => ({ slug: t.slug, name: t.name, categorySlug: t.categorySlug, subcategorySlug: t.subcategorySlug ?? null, imageUrl: t.imageUrl ?? null, isActive: t.active })) });
  }));
  r.get('/reference/types/:typeSlug/forms', ah(async (req, res) => {
    cache(res, 60);
    const rows = await catalogService.productForms(String(req.params.typeSlug));
    res.json({ items: rows.map((f) => ({ slug: f.slug, name: f.name, mineralTypeSlug: f.mineralTypeSlug, categorySlug: f.categorySlug, subcategorySlug: f.subcategorySlug, imageUrl: f.imageUrl ?? null, imageName: f.imageName ?? null, sourceId: f.sourceId ?? null, isActive: f.active })) });
  }));
  for (const [path, kind] of WEB_REFERENCE) {
    r.get(`/reference/${path}`, ah(async (_req, res) => {
      cache(res, 3600);
      res.json({ items: await svc.reference(kind) });
    }));
  }
  // Contract static content endpoints
  r.get('/content/faq', ah(async (_req, res) => { cache(res); res.json({ items: await svc.reference('faq') }); }));
  r.get('/content/how-it-works', ah(async (_req, res) => { cache(res); res.json((await svc.block('how-it-works')).data); }));
  r.get('/content/mining-hub', ah(async (_req, res) => { cache(res); res.json((await svc.block('mining-hub')).data); }));
  r.get('/content/pipelines', ah(async (_req, res) => { cache(res); res.json((await svc.block('pipelines')).data); }));
  r.get('/content/:key', ah(async (req, res) => { cache(res); res.json(await svc.block(String(req.params.key))); }));
  return r;
}

/** Web: market rates + stats. */
export function webMarketRouter(): Router {
  const r = Router();
  r.get('/market/rates', ah(async (_req, res) => {
    cache(res, 60);
    const rows = await svc.rates();
    res.json({
      items: rows.map((x) => ({
        mineral: x.mineralCode,
        unit: 'g',
        price: webMoney({ amountMinor: unitPriceMinorPerGram(x.unitPriceMinorE4PerGram), currency: x.currency }),
        change24hPct: x.change24hBps / 100,
        asOf: iso(x.asOf),
      })),
    });
  }));
  r.get('/market/stats', ah(async (_req, res) => {
    cache(res, 60);
    const s = await svc.stats();
    res.json({ ...s, asOf: iso(s.asOf) });
  }));
  return r;
}
