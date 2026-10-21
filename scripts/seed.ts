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
    if (await Rate.exists({ rateId })) continue;
    const mineralId = MINERALS.find((m) => m[1] === mineral)?.[0];
    // Desk prices sit 1 % inside the feed on both sides until someone overrides them.
    await Rate.create({ rateId, mineralId, mineral, grade, per: 'kg', feedBuy: money(buy), feedSell: money(sell), buy: money(buy), sell: money(sell), source: 'market_feed', feedSyncedAt: new Date(now), trend24hPct: 0 });
    const history = Array.from({ length: 30 }, (_, i) => {
      const day = 29 - i;
      const drift = 1 + Math.sin((i + rateId.length) / 4) * 0.012;
      const b = money(buy * drift);
      const s = money(sell * drift);
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
  const admin = await seedAdmin();
  logger.info(
    { admin, email: (process.env.SEED_ADMIN_EMAIL ?? 'ceo@mineralbridge.co.ke').toLowerCase(), database: db.connection.name },
    'Seed complete — change the admin password on first sign-in',
  );
  await disconnectDatabase();
}

main().catch(async (err) => {
  logger.error({ err }, 'Seed failed');
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
