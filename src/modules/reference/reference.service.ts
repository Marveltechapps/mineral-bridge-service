import { LABELS } from '../admin/shared/enums.js';
import { outMoney } from '../admin/shared/money.js';
import { Bank, Country, Mineral, MineralCategory, Unit } from './reference.model.js';

export const LOOKUP_TYPES = [
  'minerals',
  'grades',
  'banks',
  'exceptionTypes',
  'amendmentTypes',
  'disputeOutcomes',
  'bannerPlacements',
  'partnerTypes',
  'countries',
  'buyerAccess',
  'units',
  'categories',
] as const;
export type LookupType = (typeof LOOKUP_TYPES)[number];

const toValueLabel = (rows: readonly (readonly [string, string])[]) => rows.map(([value, label]) => ({ value, label }));

/** Enumerations shared by web, mobile and admin drawers (#18). */
export async function getLookups(types?: LookupType[]): Promise<Record<string, unknown>> {
  const want = new Set<LookupType>(types && types.length ? types : (LOOKUP_TYPES as unknown as LookupType[]));
  const out: Record<string, unknown> = {};

  if (want.has('minerals') || want.has('grades')) {
    const minerals = await Mineral.find({ active: true }).sort({ name: 1 }).lean();
    if (want.has('minerals')) {
      out.minerals = minerals.map((m) => ({ id: m.mineralId, name: m.name, categoryId: m.categoryId, units: m.units }));
    }
    if (want.has('grades')) {
      out.grades = minerals.flatMap((m) => (m.grades ?? []).map((g: string) => ({ mineralId: m.mineralId, grade: g })));
    }
  }
  if (want.has('banks')) {
    const banks = await Bank.find({ active: true }).sort({ name: 1 }).lean();
    out.banks = banks.map((b) => ({ id: b.bankId, name: b.name, country: b.country }));
  }
  if (want.has('countries')) {
    const countries = await Country.find().sort({ name: 1 }).lean();
    out.countries = countries.map((c) => ({
      code: c.code,
      name: c.name,
      dialCode: c.dialCode,
      currency: c.currency,
      btcEnabled: Boolean(c.btc?.enabled),
      btcLimit: outMoney(c.btc?.limit),
    }));
  }
  if (want.has('units')) {
    const units = await Unit.find().sort({ grams: 1 }).lean();
    out.units = units.map((u) => ({ code: u.code, name: u.name, grams: u.grams }));
  }
  if (want.has('categories')) {
    const cats = await MineralCategory.find({ active: true }).sort({ position: 1 }).lean();
    out.categories = cats.map((c) => ({ id: c.categoryId, name: c.name }));
  }
  if (want.has('exceptionTypes')) out.exceptionTypes = toValueLabel(LABELS.exceptionTypes);
  if (want.has('amendmentTypes')) out.amendmentTypes = toValueLabel(LABELS.amendmentTypes);
  if (want.has('disputeOutcomes')) out.disputeOutcomes = toValueLabel(LABELS.disputeOutcomes);
  if (want.has('bannerPlacements')) out.bannerPlacements = toValueLabel(LABELS.bannerPlacements);
  if (want.has('partnerTypes')) out.partnerTypes = toValueLabel(LABELS.partnerTypes);
  if (want.has('buyerAccess')) out.buyerAccess = toValueLabel(LABELS.buyerAccess);
  return out;
}

export async function mineralById(id: string) {
  return Mineral.findOne({ mineralId: id }).lean();
}
