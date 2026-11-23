/**
 * Idempotent database initialization for the customer app, web app, and admin dashboard.
 *
 * Runs from the API process before it listens, and from `npm run seed`.
 * Missing default rows are inserted. Existing rows are not updated, passwords are not reset,
 * and sample catalogue, rates, and customers are not written to production or to a remote database.
 */
import mongoose from 'mongoose';
import { hashPassword } from '../common/utils/crypto.js';
import { references } from '../common/utils/references.js';
import { quotedPriceToE4PerGram } from '../common/utils/pricing-math.js';
import { logger } from '../config/logger.js';
import { loadEnv } from '../config/env.js';
import { Course, CourseCategory, Lesson } from '../models/content.models.js';
import { Rate, RateHistory } from '../models/trading.models.js';
import { CategoryModel, MineralTypeModel, ProductFormModel, ProductModel, SubcategoryModel } from '../models/catalog.model.js';
import { SettingsDoc } from '../models/platform.models.js';
import { Bank, Country, Mineral, MineralCategory, Unit } from '../modules/reference/reference.model.js';
import { Role } from '../modules/auth/auth.models.js';
import { ensureSettings } from '../modules/admin/settings/settings.service.js';
import { parseUnitPrice } from '../modules/admin/shared/money.js';
import { actionsForRoleKey } from '../modules/staff/actions.js';
import { DEFAULT_ROLES } from '../modules/staff/default-roles.js';
import { ensureBootstrapAdmin, isStaffEmailDomainAllowed, validateStaffPassword } from '../modules/staff/staff.service.js';
import { PASSWORD_HISTORY_DEPTH, STAFF_PASSWORD_MIN_LENGTH } from '../modules/staff/staff.types.js';
import { UserModel } from '../modules/users/user.model.js';
import { validateCustomerPassword } from '../modules/users/user.service.js';
import {
  ACADEMY_CATEGORIES,
  BANKS,
  CATALOGUE,
  CATEGORIES,
  COUNTRIES,
  MINERALS,
  RATES,
  ROLE_CONSOLE_KEY,
  ROLE_KIND,
  SAMPLE_COURSE_ID,
  SAMPLE_PRODUCT_REFERENCES,
  SAMPLE_RATE_IDS,
  UNITS,
} from './seed-defaults.js';
import { resolveSeedPolicy, type SeedPolicy, type SeedTrigger } from './seed-policy.js';

export interface SeedCounts {
  inserted: number;
  existing: number;
}

export interface SeedReport {
  skipped: false;
  trigger: SeedTrigger;
  database: string;
  nodeEnv: string;
  localDatabase: boolean;
  sampleData: boolean;
  reference: SeedCounts;
  roles: SeedCounts;
  settings: string[];
  rates: SeedCounts;
  academy: SeedCounts;
  catalogue: SeedCounts & { skipped: boolean };
  admin: 'created' | 'unchanged' | 'skipped';
  adminEmail?: string;
  user: 'created' | 'unchanged' | 'skipped';
  userEmail?: string;
  warnings: string[];
}

export interface SeedSkipped {
  skipped: true;
  reason: string;
  warnings: string[];
}

const money = (n: number) => parseUnitPrice({ amount: n, currency: 'USD', per: 'kg' });

function emptyCounts(): SeedCounts {
  return { inserted: 0, existing: 0 };
}

function tally(res: { upsertedCount?: number }, counts: SeedCounts): void {
  if ((res.upsertedCount ?? 0) > 0) counts.inserted += 1;
  else counts.existing += 1;
}

/** Inserts a document with schema defaults (string ids included). Does not update a row that already exists. */
async function createIfMissing(
  model: { exists: (filter: object) => Promise<unknown>; create: (doc: object) => Promise<unknown> },
  filter: object,
  doc: object,
  counts: SeedCounts,
): Promise<void> {
  if (await model.exists(filter)) {
    counts.existing += 1;
    return;
  }
  try {
    await model.create(doc);
    counts.inserted += 1;
  } catch (err) {
    if (!duplicateKey(err)) throw err;
    counts.existing += 1;
  }
}

function duplicateKey(err: unknown): boolean {
  return (err as { code?: number }).code === 11000;
}

export async function assertDatabaseConnected(): Promise<string> {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    throw new Error('Database is not connected. Refusing to initialize.');
  }
  const ping = await mongoose.connection.db.command({ ping: 1 });
  if (ping.ok !== 1) throw new Error('Database ping failed. Refusing to initialize.');
  const name = mongoose.connection.name;
  if (!name) throw new Error('Database name is missing. Refusing to initialize.');
  return name;
}

async function seedReference(counts: SeedCounts): Promise<void> {
  for (const [i, [categoryId, name]] of CATEGORIES.entries()) {
    tally(await MineralCategory.updateOne({ categoryId }, { $setOnInsert: { categoryId, name, position: i, active: true } }, { upsert: true }), counts);
  }
  for (const [mineralId, name, categoryId, grades] of MINERALS) {
    tally(
      await Mineral.updateOne(
        { mineralId },
        { $setOnInsert: { mineralId, name, categoryId, grades, units: ['g', 'kg', 't'], active: true } },
        { upsert: true },
      ),
      counts,
    );
  }
  for (const [code, name, grams] of UNITS) {
    tally(await Unit.updateOne({ code }, { $setOnInsert: { code, name, grams } }, { upsert: true }), counts);
  }
  for (const [code, name, dialCode, currency, regulation, regulationLabel, rail, enabled] of COUNTRIES) {
    tally(
      await Country.updateOne(
        { code },
        { $setOnInsert: { code, name, dialCode, currency, btc: { regulation, regulationLabel, rail, enabled } } },
        { upsert: true },
      ),
      counts,
    );
  }
  for (const [bankId, name, country, swift] of BANKS) {
    tally(await Bank.updateOne({ bankId }, { $setOnInsert: { bankId, name, country, swift, active: true } }, { upsert: true }), counts);
  }
}

async function seedRoles(counts: SeedCounts): Promise<void> {
  for (const role of DEFAULT_ROLES) {
    const key = ROLE_CONSOLE_KEY[role.id];
    const actions = key ? actionsForRoleKey(key) : [];
    const doc: Record<string, unknown> = {
      roleId: role.id,
      name: role.name,
      description: role.scope,
      scope: role.scope,
      system: true,
      kind: ROLE_KIND[role.id] ?? 'desk',
      access: role.access,
    };
    if (key) doc.key = key;
    if (actions.length > 0) doc.actions = actions;
    tally(await Role.updateOne({ roleId: role.id }, { $setOnInsert: doc }, { upsert: true }), counts);
  }
}

async function seedAuthDefaults(): Promise<string[]> {
  const keys = ['roles', 'platform', 'btc'] as const;
  for (const key of keys) await ensureSettings(key);
  await SettingsDoc.updateOne(
    { key: 'auth' },
    {
      $setOnInsert: {
        key: 'auth',
        version: 1,
        values: {
          staffPasswordMinLength: STAFF_PASSWORD_MIN_LENGTH,
          customerPasswordMinLength: 10,
          passwordHistoryDepth: PASSWORD_HISTORY_DEPTH,
          secrets: 'environment',
        },
      },
    },
    { upsert: true },
  );
  return [...keys, 'auth'];
}

async function seedRates(counts: SeedCounts): Promise<void> {
  const foreign = await Rate.exists({ rateId: { $nin: SAMPLE_RATE_IDS } });
  if (foreign) return;
  const now = Date.now();
  for (const [rateId, mineral, grade, buy, sell] of RATES) {
    const mineralId = MINERALS.find((row) => row[1] === mineral)?.[0];
    const existing = await Rate.exists({ rateId });
    if (!existing) {
      try {
        await Rate.create({
          rateId,
          mineralId,
          mineral,
          grade,
          per: 'kg',
          feedBuy: money(buy),
          feedSell: money(sell),
          buy: money(buy),
          sell: money(sell),
          source: 'market_feed',
          feedSyncedAt: new Date(now),
          trend24hPct: 0,
        });
        counts.inserted += 1;
      } catch (err) {
        if (!duplicateKey(err)) throw err;
        counts.existing += 1;
      }
    } else {
      counts.existing += 1;
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

async function seedAcademy(counts: SeedCounts, sampleCourse: boolean): Promise<void> {
  for (const [i, [categoryId, name]] of ACADEMY_CATEGORIES.entries()) {
    tally(await CourseCategory.updateOne({ categoryId }, { $setOnInsert: { categoryId, name, position: i } }, { upsert: true }), counts);
  }
  if (!sampleCourse) return;
  const otherCourse = await Course.exists({ courseId: { $ne: SAMPLE_COURSE_ID } });
  if (otherCourse) return;
  if (!(await Course.exists({ courseId: SAMPLE_COURSE_ID }))) {
    try {
      await Course.create({
        courseId: SAMPLE_COURSE_ID,
        categoryId: 'CAT-GS',
        title: 'How Mineral Bridge works',
        summary: 'A five-minute tour: sell, buy, vault and settle.',
        status: 'published',
        certified: false,
        plannedLessons: 2,
      });
      counts.inserted += 1;
    } catch (err) {
      if (!duplicateKey(err)) throw err;
      counts.existing += 1;
    }
  } else {
    counts.existing += 1;
  }
  const lessons = [
    { lessonId: 'LSN-0001', courseId: SAMPLE_COURSE_ID, title: 'The marketplace in five minutes', position: 1, media: 'video_transcript', body: 'Welcome to Mineral Bridge…', status: 'published' },
    { lessonId: 'LSN-0002', courseId: SAMPLE_COURSE_ID, title: 'Tiers, KYC and limits', position: 2, media: 'text', body: 'Tier 1 can browse; Tier 2 can trade; Tier 3 unlocks auctions…', status: 'published' },
  ];
  for (const lesson of lessons) {
    if (await Lesson.exists({ lessonId: lesson.lessonId })) {
      counts.existing += 1;
      continue;
    }
    try {
      await Lesson.create(lesson);
      counts.inserted += 1;
    } catch (err) {
      if (!duplicateKey(err)) throw err;
      counts.existing += 1;
    }
  }
}

async function seedCatalogue(counts: SeedCounts): Promise<boolean> {
  const foreign = await ProductModel.exists({ status: 'active', reference: { $nin: SAMPLE_PRODUCT_REFERENCES } });
  if (foreign) return true;
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
    await createIfMissing(CategoryModel, { slug }, { slug, name: row.name, sort: row.sort, active: true, ...image(row.image) }, counts);
  }
  for (const [slug, row] of subcategories) {
    await createIfMissing(SubcategoryModel, { slug }, { slug, name: row.name, categorySlug: row.categorySlug, sort: row.sort, active: true, ...image(row.image) }, counts);
  }
  for (const [slug, row] of types) {
    await createIfMissing(
      MineralTypeModel,
      { slug },
      { slug, name: row.name, categorySlug: row.categorySlug, subcategorySlug: row.subcategorySlug, mineralCode: row.mineralCode, sellable: true, tiers: [1, 2, 3], sort: row.sort, active: true, ...image(row.image) },
      counts,
    );
  }
  for (const [slug, row] of forms) {
    await createIfMissing(
      ProductFormModel,
      { slug },
      { slug, name: row.name, categorySlug: row.categorySlug, subcategorySlug: row.subcategorySlug, mineralTypeSlug: row.mineralTypeSlug, sort: row.sort, active: true, sourceSheet: false, ...image(row.image) },
      counts,
    );
  }
  for (const lot of CATALOGUE) {
    await createIfMissing(
      ProductModel,
      { reference: lot.reference },
      {
        reference: lot.reference,
        name: lot.name,
        typeSlug: lot.typeSlug,
        categorySlug: lot.categorySlug,
        subcategorySlug: lot.subcategorySlug,
        productFormSlug: lot.formSlug,
        mineralCode: lot.mineralCode,
        form: lot.formName,
        purity: lot.purity,
        grade: lot.grade,
        lab: sampleLab(lot.reference),
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
      counts,
    );
  }
  return false;
}

/** Listed sample lots need a certificate number or the master sheet rejects them on re-upload. */
function sampleLab(reference: string): { name: string; certificateNo: string } {
  return { name: 'SGS', certificateNo: `SGS-${reference}` };
}

async function ensureSampleCertificates(): Promise<number> {
  let updated = 0;
  for (const lot of CATALOGUE) {
    const lab = sampleLab(lot.reference);
    const res = await ProductModel.updateOne(
      {
        reference: lot.reference,
        $or: [{ 'lab.certificateNo': { $exists: false } }, { 'lab.certificateNo': '' }, { 'lab.certificateNo': null }],
      },
      { $set: { lab } },
    );
    updated += res.modifiedCount ?? 0;
  }
  return updated;
}

async function seedAdmin(policy: SeedPolicy): Promise<{ status: 'created' | 'unchanged' | 'skipped'; email?: string }> {
  if (policy.admin.action !== 'create') return { status: 'skipped' };
  const status = await ensureBootstrapAdmin({
    email: policy.admin.email,
    password: policy.admin.password,
    name: policy.admin.name,
    phone: policy.admin.phone,
    roleKey: 'super',
    actions: actionsForRoleKey('super'),
  });
  return { status, email: policy.admin.email };
}

async function seedCustomer(policy: SeedPolicy): Promise<{ status: 'created' | 'unchanged' | 'skipped'; email?: string }> {
  if (policy.user.action !== 'create') return { status: 'skipped' };
  const email = policy.user.email;
  const existing = await UserModel.findOne({ email }).select('_id').lean();
  if (existing) return { status: 'unchanged', email };
  const passwordHash = await hashPassword(policy.user.password);
  try {
    await UserModel.create({
      email,
      emailVerifiedAt: new Date(),
      signInMethod: 'email',
      passwordHash,
      passwordChangedAt: new Date(),
      roles: ['both'],
      customerNo: await references.customerNo(),
      profile: { fullName: policy.user.name, countryCode: 'KE' },
      kycStatus: 'none',
      tier: 1,
    });
    return { status: 'created', email };
  } catch (err) {
    if (duplicateKey(err)) return { status: 'unchanged', email };
    throw err;
  }
}

async function rememberRun(input: { trigger: SeedTrigger; nodeEnv: string; database: string }): Promise<void> {
  const now = new Date().toISOString();
  await SettingsDoc.updateOne(
    { key: 'bootstrap' },
    {
      $set: { 'values.lastRunAt': now, 'values.nodeEnv': input.nodeEnv, 'values.trigger': input.trigger, 'values.database': input.database },
      $setOnInsert: { key: 'bootstrap', version: 1, 'values.initializedAt': now },
    },
    { upsert: true },
  );
}

async function runStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logger.error({ err, step: name }, 'Database initialization failed');
    throw err;
  }
}

export async function initializeDatabase(options: {
  trigger: SeedTrigger;
  nodeEnv?: string;
  mongoUri?: string;
  only?: 'all' | 'admin';
}): Promise<SeedReport | SeedSkipped> {
  const env = loadEnv();
  const nodeEnv = options.nodeEnv ?? env.NODE_ENV;
  const mongoUri = options.mongoUri ?? env.MONGODB_URI;
  const policy = resolveSeedPolicy({
    trigger: options.trigger,
    nodeEnv,
    mongoUri,
    staffPasswordProblem: validateStaffPassword,
    customerPasswordProblem: validateCustomerPassword,
    emailDomainAllowed: isStaffEmailDomainAllowed,
  });
  if (!policy.enabled) {
    logger.info({ trigger: options.trigger, nodeEnv }, 'Automatic database initialization is off (AUTO_SEED)');
    return { skipped: true, reason: 'AUTO_SEED is off', warnings: policy.warnings };
  }

  const database = await assertDatabaseConnected();
  const only = options.only ?? (process.env.SEED_ONLY === 'admin' ? 'admin' : 'all');
  const reference = emptyCounts();
  const roles = emptyCounts();
  const rates = emptyCounts();
  const academy = emptyCounts();
  const catalogue: SeedReport['catalogue'] = { inserted: 0, existing: 0, skipped: !policy.sampleData };
  let settings: string[] = [];

  if (only !== 'admin') {
    await runStep('sample-certificates', () => ensureSampleCertificates());
    await runStep('reference', () => seedReference(reference));
    await runStep('roles', () => seedRoles(roles));
    settings = await runStep('settings', () => seedAuthDefaults());
    if (policy.sampleData) {
      await runStep('rates', () => seedRates(rates));
      await runStep('academy', () => seedAcademy(academy, true));
      catalogue.skipped = await runStep('catalogue', () => seedCatalogue(catalogue));
    } else {
      await runStep('academy', () => seedAcademy(academy, false));
    }
  }

  const admin = await runStep('admin', () => seedAdmin(policy));
  const user = await runStep('customer', () => seedCustomer(policy));
  await runStep('marker', () => rememberRun({ trigger: options.trigger, nodeEnv, database }));

  const report: SeedReport = {
    skipped: false,
    trigger: options.trigger,
    database,
    nodeEnv,
    localDatabase: policy.localDatabase,
    sampleData: policy.sampleData,
    reference,
    roles,
    settings,
    rates,
    academy,
    catalogue,
    admin: admin.status,
    ...(admin.email ? { adminEmail: admin.email } : {}),
    user: user.status,
    ...(user.email ? { userEmail: user.email } : {}),
    warnings: policy.warnings,
  };
  for (const warning of policy.warnings) logger.warn({ database, nodeEnv }, warning);
  logger.info(
    {
      database,
      nodeEnv,
      localDatabase: policy.localDatabase,
      sampleData: policy.sampleData,
      admin: admin.status,
      adminEmail: admin.email,
      user: user.status,
      reference: reference.inserted,
      roles: roles.inserted,
      catalogue: catalogue.inserted,
    },
    'Database initialization complete',
  );
  return report;
}
