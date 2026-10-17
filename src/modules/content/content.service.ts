import { notFound } from '../../common/errors/app-error.js';
import { now } from '../../common/utils/clock.js';
import { ContentModel, RateModel, ReferenceModel } from '../../models/reference.model.js';
import type { IContentBlock, IRateSnapshot, IReferenceItem, ReferenceKind } from '../../models/reference.model.js';
import { MineralTypeModel, ProductModel } from '../../models/catalog.model.js';
import { OrderModel } from '../../models/order.model.js';
import { CONTENT_DEFAULTS, RATE_DEFAULTS, REFERENCE_DEFAULTS } from './defaults.js';

export type RefRow = { code: string; name: string; data: Record<string, unknown> };

export const contentService = {
  async reference(kind: ReferenceKind): Promise<RefRow[]> {
    const rows = await ReferenceModel.find({ kind, active: true }).sort({ sort: 1, name: 1 }).lean<IReferenceItem[]>();
    if (rows.length) return rows.map((r) => ({ code: r.code, name: r.name, data: r.data ?? {} }));
    return REFERENCE_DEFAULTS[kind].map((r) => ({ code: r.code, name: r.name, data: r.data ?? {} }));
  },

  async block(key: string): Promise<{ data: unknown; version: number }> {
    const row = await ContentModel.findById(key).lean<IContentBlock>();
    if (row) return { data: row.data, version: row.version };
    if (key in CONTENT_DEFAULTS) return { data: CONTENT_DEFAULTS[key], version: 0 };
    throw notFound('content/not-found', 'Content not found');
  },

  /** Latest snapshot per mineral (desk-published), with built-in defaults for gaps. */
  async rates(): Promise<IRateSnapshot[]> {
    const latest = await RateModel.aggregate<IRateSnapshot>([
      { $sort: { asOf: -1 } },
      { $group: { _id: '$mineralCode', doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } },
    ]);
    const have = new Set(latest.map((r) => r.mineralCode));
    const asOf = now();
    const fill = RATE_DEFAULTS.filter((d) => !have.has(d.mineralCode)).map(
      (d) => ({ _id: `default-${d.mineralCode}`, currency: 'USD', source: 'indicative', asOf, ...d }) as IRateSnapshot,
    );
    return [...latest, ...fill].sort((a, b) => a.mineralCode.localeCompare(b.mineralCode));
  },

  async stats() {
    const since = new Date(now().getTime() - 30 * 86_400_000);
    const [activeLots, orders30d, countries, mineralTypes] = await Promise.all([
      ProductModel.countDocuments({ status: 'active' }),
      OrderModel.countDocuments({ createdAt: { $gte: since } }),
      ProductModel.distinct('origin.country', { status: 'active' }),
      MineralTypeModel.countDocuments({ active: true }),
    ]);
    return { activeLots, orders30d, originCountries: countries.length, mineralTypes, asOf: now() };
  },
};
