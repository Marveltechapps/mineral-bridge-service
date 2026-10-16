import { Router } from 'express';
import { ah } from '../../common/http/async-handler.js';
import { validate } from '../../common/middleware/validate.js';
import { buildOffsetPage, pageWindow } from '../../common/utils/cursor.js';
import { createSignedUrl } from '../../common/storage/signed-url.js';
import { iso } from '../../common/utils/time-display.js';
import { optionalUser } from '../auth/auth.middleware.js';
import { catalogService } from '../catalog/catalog.service.js';
import type { ProductQuery } from '../catalog/catalog.service.js';
import { toWebLot, toWebLotDetail, toWebProvenance } from '../catalog/product.mapper.js';
import * as v from '../catalog/catalog.validation.js';

const lotId = (req: { params: Record<string, unknown> }) => String(req.params.lotId);

/** Web lots: the web view of the shared product inventory. */
export function webLotsRouter(): Router {
  const r = Router();

  r.get('/lots', optionalUser, validate({ query: v.lotListQuery }), ah(async (req, res) => {
    const win = pageWindow(req.query as { page?: unknown; perPage?: unknown });
    const { rows, total } = await catalogService.listProducts(req.query as ProductQuery, win.skip, win.perPage);
    res.json(buildOffsetPage(rows.map(toWebLot), total, win));
  }));

  // Registered before /lots/:lotId so "facets" is not captured as an id.
  r.get('/lots/facets', optionalUser, validate({ query: v.lotListQuery }), ah(async (req, res) => {
    res.json(await catalogService.facets(req.query as ProductQuery));
  }));

  r.get('/lots/:lotId', optionalUser, ah(async (req, res) => {
    res.json(toWebLotDetail(await catalogService.getProduct(lotId(req))));
  }));

  r.get('/lots/:lotId/provenance', optionalUser, ah(async (req, res) => {
    res.json(toWebProvenance(await catalogService.getProduct(lotId(req))));
  }));

  r.get('/lots/:lotId/documents', optionalUser, ah(async (req, res) => {
    const p = await catalogService.getProduct(lotId(req));
    res.json({
      items: p.documents.map((d) => ({
        id: d._id,
        name: d.name,
        kind: d.kind,
        bytes: d.bytes ?? null,
        contentType: d.contentType ?? null,
        file: d.fileId ? (({ url, expiresAt }) => ({ url, expiresAt: iso(expiresAt) }))(createSignedUrl('file', d.fileId)) : null,
      })),
    });
  }));

  return r;
}
