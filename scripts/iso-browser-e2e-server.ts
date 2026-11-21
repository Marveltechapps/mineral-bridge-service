/**
 * Long-running isolated API for browser E2E (dashboard + web). In-memory MongoDB only; never reads Atlas.
 * Usage: PORT=5031 WEB_ORIGIN=http://localhost:3100 tsx scripts/iso-browser-e2e-server.ts
 */
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const PORT = Number(process.env.ISO_PORT || 5031);
const WEB_ORIGIN = process.env.ISO_WEB_ORIGIN || 'http://localhost:3100';
const DASH_ORIGIN = process.env.ISO_DASH_ORIGIN || 'http://localhost:5173,http://localhost:5175';

function expandOrigins(value: string): string[] {
  const listed = value.split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set(listed.flatMap((origin) => [origin, origin.replace('localhost', '127.0.0.1')]))];
}

const repl = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
process.env.MONGODB_URI = repl.getUri('mb_browser_e2e');
process.env.NODE_ENV = 'development';
process.env.DEV_OTP_ENABLED = 'true';
process.env.PORT = String(PORT);
process.env.HOST = '127.0.0.1';
process.env.OTP_PROVIDER = 'fake';
process.env.EMAIL_PROVIDER = 'fake';
process.env.COOKIE_SECURE = 'false';
process.env.CORS_WEB_ORIGINS = expandOrigins(WEB_ORIGIN).join(',');
process.env.CORS_ADMIN_ORIGINS = expandOrigins(DASH_ORIGIN).join(',');
// Keep the legacy combined list from being loaded out of a developer .env.
process.env.ALLOWED_ORIGINS = '';
process.env.CORS_MOBILE_ORIGINS = '*';
process.env.LOG_LEVEL = 'warn';

const { resetEnvCache } = await import('../src/config/env.js');
resetEnvCache();
const { connectDatabase } = await import('../src/config/database.js');
const { createApp } = await import('../src/app.js');
const { createStaff } = await import('../src/modules/staff/staff.service.js');
const { UserModel } = await import('../src/modules/users/user.model.js');
const { KycSubmissionModel } = await import('../src/modules/kyc/kyc.model.js');
const { ProductModel } = await import('../src/models/catalog.model.js');
const { SupportTicketModel } = await import('../src/models/support.model.js');

await connectDatabase();
await createStaff({
  email: 'ceo@mineralbridge.test',
  password: 'Correct-Horse-9!Battery',
  name: 'Platform CEO',
  roleId: 'ROLE-CEO',
});

const buyer = await UserModel.create({
  customerNo: 'C-6001',
  email: 'verified.buyer@example.com',
  phone: '+254711600001',
  roles: ['both'],
  kycStatus: 'verified',
  accountStatus: 'active',
  profile: { fullName: 'Verified Buyer Iso', countryCode: 'KE' },
});

const pending = await UserModel.create({
  customerNo: 'C-6002',
  email: 'pending.kyc@example.com',
  phone: '+254711600002',
  roles: ['buyer'],
  kycStatus: 'pending',
  accountStatus: 'active',
  profile: { fullName: 'Pending Kyc Iso', countryCode: 'KE' },
});
await KycSubmissionModel.create({
  publicId: 'kyc_browser_pending',
  reference: 'MB-KYC-BR-PENDING',
  userId: pending._id,
  status: 'pending',
  source: 'web',
  idTypeId: 'passport',
  requiredKinds: ['id_front'],
});

const { CategoryModel, MineralTypeModel, SubcategoryModel } = await import('../src/models/catalog.model.js');
await CategoryModel.create([
  { slug: 'precious', name: 'Precious metals', sort: 1, active: true },
  { slug: 'industrial', name: 'Industrial minerals', sort: 2, active: true },
]);
await SubcategoryModel.create([
  { slug: 'gold-sub', name: 'Gold', categorySlug: 'precious', sort: 1, active: true },
  { slug: 'base-sub', name: 'Base metals', categorySlug: 'industrial', sort: 1, active: true },
]);
await MineralTypeModel.create([
  { slug: 'gold', name: 'Gold', categorySlug: 'precious', subcategorySlug: 'gold-sub', mineralCode: 'AU', sellable: true, tiers: [1, 2, 3], sort: 1, active: true },
  { slug: 'copper', name: 'Copper', categorySlug: 'industrial', subcategorySlug: 'base-sub', mineralCode: 'CU', sellable: true, tiers: [1, 2, 3], sort: 2, active: true },
  { slug: 'lithium', name: 'Lithium', categorySlug: 'industrial', subcategorySlug: 'base-sub', mineralCode: 'LI', sellable: true, tiers: [1, 2, 3], sort: 3, active: true },
]);

for (const [i, name] of ['Iso Gold Dore', 'Iso Copper Cathode', 'Iso Lithium Spodumene'].entries()) {
  await ProductModel.create({
    reference: `LOT-BR-${i + 1}`,
    name,
    typeSlug: ['gold', 'copper', 'lithium'][i],
    categorySlug: i === 0 ? 'precious' : 'industrial',
    mineralCode: ['AU', 'CU', 'LI'][i],
    origin: { country: 'KE' },
    status: 'active',
    availableGrams: 50_000,
    minOrderGrams: 100,
    unitPriceMinorE4PerGram: 10_000,
    seller: { name: 'Mineral Bridge', tier: 'mineral_bridge', verified: true },
    attributes: {},
  });
}

await SupportTicketModel.create({
  reference: 'TCK-BR-1',
  userId: String(buyer._id),
  topic: 'order',
  subject: 'Seeded support ticket',
  body: 'Seeded inbox message.',
  status: 'open',
  messages: [{ author: 'user', authorName: 'Verified Buyer Iso', body: 'Seeded inbox message.', attachmentIds: [], at: new Date() }],
  version: 0,
});

const app = createApp();
app.listen(PORT, '127.0.0.1', () => {
  console.log(`ISOLATED_READY http://127.0.0.1:${PORT}`);
});
