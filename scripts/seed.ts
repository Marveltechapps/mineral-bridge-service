/**
 * Idempotent seed: reference data, role matrix, platform settings, sample rates (+ 30 days of history),
 * academy categories and the first CEO staff account.
 *
 *   npm run seed                       (PowerShell: $env:SEED_ADMIN_PASSWORD="…"; npm run seed)
 *
 * Env: SEED_ADMIN_EMAIL (default ceo@mineralbridge.co.ke), SEED_ADMIN_PASSWORD (default ChangeMe!Admin1),
 *      SEED_ADMIN_PHONE (default +254700000001 — OTP codes are sent here), SEED_ADMIN_NAME.
 * Re-running never duplicates rows. The bootstrap admin password is set to SEED_ADMIN_PASSWORD
 * when the stored hash does not already match it. Other staff records are not changed.
 */
import 'dotenv/config';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { logger } from '../src/config/logger.js';
import { Course, CourseCategory, Lesson } from '../src/models/content.models.js';
import { Rate, RateHistory } from '../src/models/trading.models.js';
import { Role } from '../src/modules/auth/auth.models.js';
import { ensureSettings } from '../src/modules/admin/settings/settings.service.js';
import { parseUnitPrice } from '../src/modules/admin/shared/money.js';
import { quotedPriceToE4PerGram } from '../src/common/utils/pricing-math.js';
import { CategoryModel, MineralTypeModel, ProductFormModel, ProductModel, SubcategoryModel } from '../src/models/catalog.model.js';
import { Bank, Country, Mineral, MineralCategory, Unit } from '../src/modules/reference/reference.model.js';
import { DEFAULT_ROLES } from '../src/modules/staff/default-roles.js';
import { ensureBootstrapAdmin } from '../src/modules/staff/staff.service.js';

const ROLE_KIND: Record<string, string> = {
  'ROLE-CEO': 'executive',
  'ROLE-DESK': 'desk',
  'ROLE-COMPLIANCE': 'compliance',
  'ROLE-SUPPORT': 'support',
  'ROLE-CONTENT': 'content',
  'ROLE-FIELD': 'field_agent',
  'ROLE-DATA': 'data_entry',
};

const CATEGORIES = [
  ['CAT-PRECIOUS', 'Precious metals'],
  ['CAT-BASE', 'Base metals'],
  ['CAT-BATTERY', 'Battery & critical minerals'],
  ['CAT-GEMS', 'Gemstones'],
  ['CAT-INDUSTRIAL', 'Industrial minerals'],
] as const;

const MINERALS: Array<[string, string, string, string[]]> = [
  ['MIN-AU', 'Gold Concentrate', 'CAT-PRECIOUS', ['85%+ Au', '70-85% Au', '<70% Au']],
  ['MIN-AUD', 'Gold Doré', 'CAT-PRECIOUS', ['90%+ Au', '75-90% Au']],
  ['MIN-AG', 'Silver Concentrate', 'CAT-PRECIOUS', ['>90% Ag']],
  ['MIN-CU', 'Copper Cathode', 'CAT-BASE', ['Grade A (99.99%)']],
  ['MIN-SN', 'Tin Concentrate', 'CAT-BASE', ['65% Sn']],
  ['MIN-CO', 'Cobalt Hydroxide', 'CAT-BATTERY', ['30% Co']],
  ['MIN-LI', 'Lithium Spodumene', 'CAT-BATTERY', ['6% Li2O']],
  ['MIN-TA', 'Coltan (Tantalite)', 'CAT-BATTERY', ['30% Ta2O5']],
  ['MIN-W', 'Wolframite', 'CAT-BASE', ['65% WO3']],
  ['MIN-EM', 'Emerald (rough)', 'CAT-GEMS', ['AAA', 'AA', 'A']],
  ['MIN-TZ', 'Tanzanite (rough)', 'CAT-GEMS', ['AAA', 'AA']],
  ['MIN-GR', 'Graphite', 'CAT-INDUSTRIAL', ['94% C']],
];

const UNITS = [
  ['g', 'Gram', 1],
  ['kg', 'Kilogram', 1000],
  ['t', 'Tonne', 1_000_000],
  ['oz', 'Troy ounce', 31.1034768],
] as const;

/** [code, name, dialCode, currency, btc regulation, label, rail, enabled] */
const COUNTRIES: Array<[string, string, string, string, string, string, string, boolean]> = [
  ['KE', 'Kenya', '+254', 'KES', 'permitted_limited', 'VASP Act 2025 — licence required', 'on_chain', true],
  ['NG', 'Nigeria', '+234', 'NGN', 'permitted_limited', 'SEC digital-asset rules', 'on_chain', false],
  ['GH', 'Ghana', '+233', 'GHS', 'restricted', 'Bank of Ghana — pending framework', 'none', false],
  ['TZ', 'Tanzania', '+255', 'TZS', 'restricted', 'No clear regime', 'none', false],
  ['UG', 'Uganda', '+256', 'UGX', 'restricted', 'Central bank warning in force', 'none', false],
  ['ZA', 'South Africa', '+27', 'ZAR', 'permitted_vasp', 'FSCA-licensed CASPs', 'lightning_and_onchain', true],
  ['ZM', 'Zambia', '+260', 'ZMW', 'restricted', 'Under review', 'none', false],
  ['CD', 'DR Congo', '+243', 'CDF', 'prohibited', 'Not recognised', 'none', false],
  ['RW', 'Rwanda', '+250', 'RWF', 'restricted', 'Under review', 'none', false],
  ['AE', 'United Arab Emirates', '+971', 'AED', 'permitted_vasp', 'VARA-licensed VASPs', 'lightning_and_onchain', true],
  ['CH', 'Switzerland', '+41', 'CHF', 'permitted_vasp', 'FINMA-regulated', 'lightning_and_onchain', true],
  ['GB', 'United Kingdom', '+44', 'GBP', 'permitted_vasp', 'FCA-registered', 'on_chain', true],
  ['US', 'United States', '+1', 'USD', 'permitted_limited', 'State-by-state MSB rules', 'on_chain', false],
];

const BANKS: Array<[string, string, string, string]> = [
  ['BNK-KCB', 'KCB Bank Kenya', 'KE', 'KCBLKENX'],
  ['BNK-EQT', 'Equity Bank Kenya', 'KE', 'EQBLKENA'],
  ['BNK-STD', 'Standard Chartered', 'GB', 'SCBLGB2L'],
  ['BNK-ENBD', 'Emirates NBD', 'AE', 'EBILAEAD'],
  ['BNK-UBS', 'UBS Switzerland', 'CH', 'UBSWCHZH'],
];

/** [id, mineral, grade, feed buy, feed sell] — USD per kg. Sell = what we charge buyers; buy = what we pay sellers. */
const RATES: Array<[string, string, string, number, number]> = [
  ['RATE-AU-85', 'Gold Concentrate', '85%+ Au', 61_200, 63_900],
  ['RATE-AU-70', 'Gold Concentrate', '70-85% Au', 51_400, 53_700],
  ['RATE-AUD-90', 'Gold Doré', '90%+ Au', 69_800, 72_100],
  ['RATE-AG', 'Silver Concentrate', '>90% Ag', 780, 835],
  ['RATE-CU', 'Copper Cathode', 'Grade A (99.99%)', 9.1, 9.7],
  ['RATE-SN', 'Tin Concentrate', '65% Sn', 27.4, 29.8],
  ['RATE-CO', 'Cobalt Hydroxide', '30% Co', 14.9, 16.2],
  ['RATE-TA', 'Coltan (Tantalite)', '30% Ta2O5', 86, 94],
];

const ACADEMY_CATEGORIES: Array<[string, string]> = [
  ['CAT-GS', 'Getting Started'],
  ['CAT-SELL', 'Selling Minerals'],
  ['CAT-BUY', 'Buying & Auctions'],
  ['CAT-KYC', 'Compliance & KYC'],
  ['CAT-LOG', 'Logistics & Vault'],
  ['CAT-TF', 'Trade Finance'],
];

const money = (n: number) => parseUnitPrice({ amount: n, currency: 'USD', per: 'kg' });

async function seedReference(): Promise<void> {
  for (const [i, [categoryId, name]] of CATEGORIES.entries()) await MineralCategory.updateOne({ categoryId }, { $set: { name, position: i }, $setOnInsert: { active: true } }, { upsert: true });
  for (const [mineralId, name, categoryId, grades] of MINERALS) await Mineral.updateOne({ mineralId }, { $set: { name, categoryId, grades, units: ['g', 'kg', 't'] }, $setOnInsert: { active: true } }, { upsert: true });
  for (const [code, name, grams] of UNITS) await Unit.updateOne({ code }, { $set: { name, grams } }, { upsert: true });
  for (const [code, name, dialCode, currency, regulation, regulationLabel, rail, enabled] of COUNTRIES) {
    await Country.updateOne({ code }, { $set: { name, dialCode, currency, 'btc.regulation': regulation, 'btc.regulationLabel': regulationLabel, 'btc.rail': rail }, $setOnInsert: { 'btc.enabled': enabled } }, { upsert: true });
  }
  for (const [bankId, name, country, swift] of BANKS) await Bank.updateOne({ bankId }, { $set: { name, country, swift }, $setOnInsert: { active: true } }, { upsert: true });
}

async function seedRoles(): Promise<void> {
  for (const r of DEFAULT_ROLES) {
    await Role.updateOne({ roleId: r.id }, { $set: { name: r.name, description: r.scope, scope: r.scope, system: true, kind: ROLE_KIND[r.id] ?? 'desk' }, $setOnInsert: { access: r.access } }, { upsert: true });
  }
  for (const key of ['roles', 'platform', 'btc'] as const) await ensureSettings(key);
}

async function seedRates(): Promise<void> {
  const now = Date.now();
  for (const [rateId, mineral, grade, buy, sell] of RATES) {
    const mineralId = MINERALS.find((m) => m[1] === mineral)?.[0];
    // Desk prices sit 1 % inside the feed on both sides until someone overrides them.
    if (!(await Rate.exists({ rateId }))) {
      await Rate.create({ rateId, mineralId, mineral, grade, per: 'kg', feedBuy: money(buy), feedSell: money(sell), buy: money(buy), sell: money(sell), source: 'market_feed', feedSyncedAt: new Date(now), trend24hPct: 0 });
    }
    if (await RateHistory.exists({ rateId })) continue;
    const history = Array.from({ length: 30 }, (_, i) => {
      const day = 29 - i;
      const drift = 1 + Math.sin((i + rateId.length) / 4) * 0.012;
      const cents = (n: number) => Number((n * drift).toFixed(2));
      const b = money(cents(buy));
      const s = money(cents(sell));
      return { rateId, at: new Date(now - day * 86_400_000), buyMinor: b.amountMinor, sellMinor: s.amountMinor, currency: 'USD', scale: 2, per: 'kg' };
    });
    await RateHistory.insertMany(history);
  }
}

async function seedAcademy(): Promise<void> {
  for (const [i, [categoryId, name]] of ACADEMY_CATEGORIES.entries()) await CourseCategory.updateOne({ categoryId }, { $set: { name, position: i } }, { upsert: true });
  if (await Course.exists({ courseId: 'CRS-0001' })) return;
  await Course.create({ courseId: 'CRS-0001', categoryId: 'CAT-GS', title: 'How Mineral Bridge works', summary: 'A five-minute tour: sell, buy, vault and settle.', status: 'published', certified: false, plannedLessons: 2 });
  await Lesson.create([
    { lessonId: 'LSN-0001', courseId: 'CRS-0001', title: 'The marketplace in five minutes', position: 1, media: 'video_transcript', body: 'Welcome to Mineral Bridge…', status: 'published' },
    { lessonId: 'LSN-0002', courseId: 'CRS-0001', title: 'Tiers, KYC and limits', position: 2, media: 'text', body: 'Tier 1 can browse; Tier 2 can trade; Tier 3 unlocks auctions…', status: 'published' },
  ]);
}

/** Marketplace lots the web and mobile catalogues read from `/v2/catalogue`. Idempotent on slug / reference. */
const CATALOGUE: Array<{
  categorySlug: string;
  categoryName: string;
  categoryImage: string;
  subcategorySlug: string;
  subcategoryName: string;
  typeSlug: string;
  typeName: string;
  mineralCode: string;
  formSlug: string;
  formName: string;
  reference: string;
  name: string;
  grade: string;
  purity: string;
  country: string;
  region: string;
  site: string;
  grams: number;
  minGrams: number;
  /** USD per kilogram. */
  usdPerKg: number;
  imageName: string;
  description: string;
}> = [
  ['precious-metals', 'Precious metals', 'cat-precious', 'gold', 'Gold', 'gold-dore', 'Gold Doré', 'AU', 'dore-bar', 'Doré bar', 'MBV-AU-DORE-01', 'Ashanti gold doré bar', '90%+ Au', '92.4% Au', 'GH', 'Ashanti', 'Obuasi', 12_400, 100, 69_800, 'gold-dore', 'Poured doré from a licensed Ghanaian producer. Weight and fineness checked at the vault.'],
  ['precious-metals', 'Precious metals', 'cat-precious', 'gold', 'Gold', 'gold-concentrate', 'Gold Concentrate', 'AU', 'gold-concentrate', 'Concentrate', 'MBV-AU-CONC-01', 'Geita gold concentrate', '85%+ Au', '86.1% Au', 'TZ', 'Geita', 'Geita', 250_000, 1_000, 63_900, 'gold-concentrate', 'Gravity concentrate, bagged and sealed. Assay report available with the lot.'],
  ['precious-metals', 'Precious metals', 'cat-precious', 'gold', 'Gold', 'gold-bullion', 'Gold Bullion', 'AU', 'bullion', 'Bullion', 'MBV-AU-BULL-01', 'Rand gold bullion', '99.5% Au', '99.5% Au', 'ZA', 'Gauteng', 'Johannesburg', 8_000, 100, 72_100, 'gold-bullion', 'Small-bar bullion held in a bonded vault. Suitable for refinery and investor buyers.'],
  ['precious-metals', 'Precious metals', 'cat-precious', 'silver', 'Silver', 'silver-concentrate', 'Silver Concentrate', 'AG', 'silver-concentrate', 'Concentrate', 'MBV-AG-CONC-01', 'Taxco silver concentrate', '>90% Ag', '91.2% Ag', 'MX', 'Guerrero', 'Taxco', 400_000, 5_000, 835, 'm-silver', 'Flotation concentrate from a registered mill. Moisture and penalty elements disclosed.'],
  ['base-metals', 'Base metals', 'cat-industrial', 'copper', 'Copper', 'copper-cathode', 'Copper Cathode', 'CU', 'cathode', 'Cathode', 'MBV-CU-CATH-01', 'Copperbelt cathode', 'Grade A (99.99%)', '99.99% Cu', 'ZM', 'Copperbelt', 'Kitwe', 5_000_000, 25_000, 9.7, 'cat-industrial', 'LME-grade cathode, strapped bundles. Ready for export from the bonded yard.'],
  ['base-metals', 'Base metals', 'cat-industrial', 'tin', 'Tin', 'tin-concentrate', 'Tin Concentrate', 'SN', 'tin-concentrate', 'Concentrate', 'MBV-SN-CONC-01', 'Jos tin concentrate', '65% Sn', '67% Sn', 'NG', 'Plateau', 'Jos', 80_000, 1_000, 29.8, 'cat-industrial', 'Alluvial tin concentrate, dried and bagged. Export permit on file.'],
  ['battery-minerals', 'Battery & critical minerals', 'cat-critical', 'cobalt', 'Cobalt', 'cobalt-hydroxide', 'Cobalt Hydroxide', 'CO', 'hydroxide', 'Hydroxide', 'MBV-CO-HYD-01', 'Kolwezi cobalt hydroxide', '30% Co', '32% Co', 'CD', 'Lualaba', 'Kolwezi', 1_200_000, 10_000, 16.2, 'cat-critical', 'Crude hydroxide from a traceable cooperative. Moisture and payability stated on the assay.'],
  ['battery-minerals', 'Battery & critical minerals', 'cat-critical', 'lithium', 'Lithium', 'lithium-spodumene', 'Lithium Spodumene', 'LI', 'spodumene', 'Spodumene', 'MBV-LI-SPO-01', 'Bikita spodumene', '6% Li2O', '6.1% Li2O', 'ZW', 'Masvingo', 'Bikita', 8_000_000, 50_000, 1.15, 'cat-critical', 'SC6 spodumene concentrate in bulk bags. Sampling certificate attached to the lot.'],
  ['battery-minerals', 'Battery & critical minerals', 'cat-critical', 'coltan', 'Coltan', 'coltan-tantalite', 'Coltan (Tantalite)', 'TA', 'tantalite', 'Tantalite', 'MBV-TA-COL-01', 'Kigali tantalite', '30% Ta2O5', '31% Ta2O5', 'RW', 'Kigali', 'Kigali', 180_000, 1_000, 94, 'cat-critical', 'Hand-sorted tantalite. Chain-of-custody documents travel with the shipment.'],
  ['gemstones', 'Gemstones', 'cat-gemstone', 'emerald', 'Emerald', 'emerald-rough', 'Emerald (rough)', 'EM', 'emerald-rough', 'Rough', 'MBV-EM-RGH-01', 'Kagem rough emerald', 'AA', 'AA', 'ZM', 'Copperbelt', 'Kagem', 1_500, 50, 420_000, 'cat-gemstone', 'Rough emerald parcel, individually weighed. Not a treated stone.'],
  ['gemstones', 'Gemstones', 'cat-gemstone', 'tanzanite', 'Tanzanite', 'tanzanite-rough', 'Tanzanite (rough)', 'TZ', 'tanzanite-rough', 'Rough', 'MBV-TZ-RGH-01', 'Merelani tanzanite', 'AA', 'AA', 'TZ', 'Manyara', 'Merelani', 800, 20, 610_000, 'cat-gemstone', 'Rough tanzanite from the Merelani block. Parcel weight is the sellable quantity.'],
  ['industrial-minerals', 'Industrial minerals', 'cat-industrial', 'graphite', 'Graphite', 'graphite-flake', 'Graphite', 'GR', 'flake', 'Flake', 'MBV-GR-FLK-01', 'Balama flake graphite', '94% C', '94.6% C', 'MZ', 'Cabo Delgado', 'Balama', 12_000_000, 100_000, 0.85, 'cat-industrial', 'Natural flake graphite, jumbo and large flake. Packed for industrial offtake.'],
].map((row) => {
  const [categorySlug, categoryName, categoryImage, subcategorySlug, subcategoryName, typeSlug, typeName, mineralCode, formSlug, formName, reference, name, grade, purity, country, region, site, grams, minGrams, usdPerKg, imageName, description] = row;
  return { categorySlug, categoryName, categoryImage, subcategorySlug, subcategoryName, typeSlug, typeName, mineralCode, formSlug, formName, reference, name, grade, purity, country, region, site, grams, minGrams, usdPerKg, imageName, description };
});

async function seedCatalogue(): Promise<number> {
  const sampleRefs = CATALOGUE.map((lot) => lot.reference);
  const sampleCategories = [...new Set(CATALOGUE.map((lot) => lot.categorySlug))];
  // A synced sheet catalogue is the live data. Sample lots are only for an empty database.
  if (await ProductModel.exists({ status: 'active', reference: { $nin: sampleRefs } })) {
    await ProductModel.deleteMany({ reference: { $in: sampleRefs } });
    await CategoryModel.deleteMany({ slug: { $in: sampleCategories } });
    await SubcategoryModel.deleteMany({ categorySlug: { $in: sampleCategories } });
    await MineralTypeModel.deleteMany({ categorySlug: { $in: sampleCategories } });
    await ProductFormModel.deleteMany({ categorySlug: { $in: sampleCategories } });
    return 0;
  }
  const categories = new Map<string, { name: string; image: string; sort: number }>();
  const subcategories = new Map<string, { name: string; categorySlug: string; image: string; sort: number }>();
  const types = new Map<string, { name: string; categorySlug: string; subcategorySlug: string; mineralCode: string; image: string; sort: number }>();
  const forms = new Map<string, { name: string; categorySlug: string; subcategorySlug: string; mineralTypeSlug: string; image: string; sort: number }>();
  for (const lot of CATALOGUE) {
    if (!categories.has(lot.categorySlug)) categories.set(lot.categorySlug, { name: lot.categoryName, image: lot.categoryImage, sort: categories.size });
    if (!subcategories.has(lot.subcategorySlug)) subcategories.set(lot.subcategorySlug, { name: lot.subcategoryName, categorySlug: lot.categorySlug, image: lot.imageName, sort: subcategories.size });
    if (!types.has(lot.typeSlug)) types.set(lot.typeSlug, { name: lot.typeName, categorySlug: lot.categorySlug, subcategorySlug: lot.subcategorySlug, mineralCode: lot.mineralCode, image: lot.imageName, sort: types.size });
    if (!forms.has(lot.formSlug)) forms.set(lot.formSlug, { name: lot.formName, categorySlug: lot.categorySlug, subcategorySlug: lot.subcategorySlug, mineralTypeSlug: lot.typeSlug, image: lot.imageName, sort: forms.size });
  }
  const image = (name: string) => ({ imageName: name, imageUrl: `/assets/m4/${name}.png` });
  for (const [slug, row] of categories) {
    await CategoryModel.updateOne({ slug }, { $set: { name: row.name, sort: row.sort, active: true, ...image(row.image) } }, { upsert: true });
  }
  for (const [slug, row] of subcategories) {
    await SubcategoryModel.updateOne({ slug }, { $set: { name: row.name, categorySlug: row.categorySlug, sort: row.sort, active: true, ...image(row.image) } }, { upsert: true });
  }
  for (const [slug, row] of types) {
    await MineralTypeModel.updateOne(
      { slug },
      { $set: { name: row.name, categorySlug: row.categorySlug, subcategorySlug: row.subcategorySlug, mineralCode: row.mineralCode, sellable: true, tiers: [1, 2, 3], sort: row.sort, active: true, ...image(row.image) } },
      { upsert: true },
    );
  }
  for (const [slug, row] of forms) {
    await ProductFormModel.updateOne(
      { slug },
      { $set: { name: row.name, categorySlug: row.categorySlug, subcategorySlug: row.subcategorySlug, mineralTypeSlug: row.mineralTypeSlug, sort: row.sort, active: true, sourceSheet: false, ...image(row.image) } },
      { upsert: true },
    );
  }
  for (const lot of CATALOGUE) {
    await ProductModel.updateOne(
      { reference: lot.reference },
      {
        $set: {
          name: lot.name,
          typeSlug: lot.typeSlug,
          categorySlug: lot.categorySlug,
          subcategorySlug: lot.subcategorySlug,
          productFormSlug: lot.formSlug,
          mineralCode: lot.mineralCode,
          form: lot.formName,
          purity: lot.purity,
          grade: lot.grade,
          origin: { country: lot.country, region: lot.region, site: lot.site, display: `${lot.site}, ${lot.region}` },
          seller: { name: 'Mineral Bridge', tier: 'mineral_bridge', verified: true },
          status: 'active',
          availableGrams: lot.grams,
          minOrderGrams: lot.minGrams,
          stepGrams: lot.minGrams,
          currency: 'USD',
          unitPriceMinorE4PerGram: quotedPriceToE4PerGram(lot.usdPerKg, 'kg'),
          assured: true,
          verified: true,
          featured: true,
          ...image(lot.imageName),
          description: lot.description,
          attributes: {
            unit: 'kg',
            listPrice: lot.usdPerKg,
            categoryName: lot.categoryName,
            subcategoryName: lot.subcategoryName,
            mineralTypeName: lot.typeName,
            productFormName: lot.formName,
            sourceSheet: false,
          },
        },
      },
      { upsert: true },
    );
  }
  return CATALOGUE.length;
}

/** Demo stock for published lots that are still at zero, so the storefront is not a wall of sold-out cards. Lots that already have quantity are left alone. */
async function seedStock(): Promise<number> {
  const res = await ProductModel.updateMany(
    { status: 'active', availableGrams: 0 },
    { $set: { availableGrams: 25_000, minOrderGrams: 1_000, stepGrams: 500 } },
  );
  return res.modifiedCount;
}

async function seedAdmin(): Promise<'created' | 'updated' | 'unchanged'> {
  const email = (process.env.SEED_ADMIN_EMAIL ?? 'ceo@mineralbridge.co.ke').toLowerCase();
  return ensureBootstrapAdmin({
    email,
    password: process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe!Admin1',
    name: process.env.SEED_ADMIN_NAME ?? 'Platform CEO',
    phone: process.env.SEED_ADMIN_PHONE ?? '+254700000001',
  });
}

async function main(): Promise<void> {
  const db = await connectDatabase();
  if (process.env.SEED_ONLY === 'admin') {
    const admin = await seedAdmin();
    logger.info(
      {
        admin,
        email: (process.env.SEED_ADMIN_EMAIL ?? 'ceo@mineralbridge.co.ke').toLowerCase(),
        database: db.connection.name,
      },
      'Bootstrap admin ready',
    );
    await disconnectDatabase();
    return;
  }
  await seedReference();
  await seedRoles();
  await seedRates();
  await seedAcademy();
  const lots = await seedCatalogue();
  const stocked = await seedStock();
  const admin = await seedAdmin();
  logger.info(
    { admin, lots, stocked, email: (process.env.SEED_ADMIN_EMAIL ?? 'ceo@mineralbridge.co.ke').toLowerCase(), database: db.connection.name },
    'Seed complete — change the admin password on first sign-in',
  );
  await disconnectDatabase();
}

main().catch(async (err) => {
  logger.error({ err }, 'Seed failed');
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
