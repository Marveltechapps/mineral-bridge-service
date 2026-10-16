import { Router } from 'express';
import { ah } from '../../common/http/async-handler.js';
import { mobileMoney, webMoney } from '../../common/utils/currency.js';
import { unitPriceMinorPerGram } from '../../common/utils/pricing-math.js';
import { iso } from '../../common/utils/time-display.js';
import { optionalUser } from '../auth/auth.middleware.js';
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
  ['categories', 'category'],
  ['minerals', 'mineral'],
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
