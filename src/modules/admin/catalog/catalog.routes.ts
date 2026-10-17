import { conflict, notFound } from '../../../common/errors/app-error.js';
import { ProductFormModel } from '../../../models/catalog.model.js';
import { catalogService } from '../../catalog/catalog.service.js';
import { formPatch } from '../../catalog/catalog.validation.js';
import { action } from '../shared/http.js';
import { route, type AdminRouteDef } from '../shared/route-kit.js';

/**
 * Catalog taxonomy is read from the same collections the sheet importer writes.
 * Sheet-owned names, images, and parent slugs are not editable here.
 */
export const catalogAdminRoutes: AdminRouteDef[] = [
  route(140, 'GET /catalog/hierarchy', ['content', 'view'], async (_req, res) => {
    res.json({
      categories: await catalogService.hierarchy(),
      sheetOwnedFields: ['name', 'slug', 'categorySlug', 'subcategorySlug', 'mineralTypeSlug', 'imageUrl', 'imageName', 'sourceId'],
    });
  }),

  route(141, 'PATCH /catalog/forms/:slug', ['content', 'edit'], async (req, res) => {
    const slug = String(req.params.slug);
    const body = req.body as { active: boolean };
    const existing = await ProductFormModel.findOne({ slug }).lean();
    if (!existing) throw notFound('catalog/form-not-found', 'Product form not found');
    if (existing.sourceSheet && Object.keys(req.body as object).some((key) => key !== 'active')) {
      throw conflict('catalog/sheet-owned', 'The Google Sheet owns this product form. Only active can be changed, and the next import restores it.');
    }
    await ProductFormModel.updateOne({ slug }, { $set: { active: body.active } });
    res.json(action({ slug, isActive: body.active, sourceSheet: existing.sourceSheet }, existing.sourceSheet ? 'Active flag saved. The next sheet import restores sheet-owned rows to active.' : 'Product form updated', slug));
  }, formPatch ? { body: formPatch } : {}),
];
