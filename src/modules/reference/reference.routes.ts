import { Router } from 'express';
import { z } from 'zod';
import { LOOKUP_TYPES, getLookups, type LookupType } from './reference.service.js';

/** Public, cacheable reference data for /v1 (mobile + web). Contains no personal data. */
export const referenceRouter = Router();

referenceRouter.get('/reference', async (req, res, next) => {
  try {
    const q = z.object({ types: z.string().optional() }).parse(req.query);
    const types = q.types
      ? (q.types.split(',').filter((t) => (LOOKUP_TYPES as readonly string[]).includes(t)) as LookupType[])
      : undefined;
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(await getLookups(types));
  } catch (err) {
    next(err);
  }
});

for (const type of ['minerals', 'countries', 'units', 'categories', 'banks'] as const) {
  referenceRouter.get(`/reference/${type}`, async (_req, res, next) => {
    try {
      const data = await getLookups([type]);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.json({ data: data[type] ?? [] });
    } catch (err) {
      next(err);
    }
  });
}
