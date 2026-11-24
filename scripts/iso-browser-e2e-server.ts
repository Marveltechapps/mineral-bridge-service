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
process.env.OTP_MAX_PER_PHONE_15MIN = '50';
process.env.OTP_MAX_PER_IP_15MIN = '200';
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
    ...(i === 0
      ? {
          grade: '99.5%',
          lab: { name: 'SGS', certificateNo: 'ISO-COA-1' },
          documents: [{
            _id: 'doc_iso_coa',
            name: 'Iso assay certificate.pdf',
            kind: 'certificate_of_analysis',
            url: 'https://example.com/iso-coa.pdf',
            contentType: 'application/pdf',
            visible: true,
          }],
        }
      : {}),
  });
}

await ProductModel.create({
  reference: 'LOT-SOLD',
  name: 'Iso Sold Gold',
  typeSlug: 'gold',
  categorySlug: 'precious',
  mineralCode: 'AU',
  origin: { country: 'KE' },
  status: 'sold',
  availableGrams: 0,
  minOrderGrams: 100,
  unitPriceMinorE4PerGram: 10_000,
  seller: { name: 'Mineral Bridge', tier: 'mineral_bridge', verified: true },
  attributes: {},
});

await ProductModel.create({
  reference: 'LOT-REQUEST',
  name: 'Iso Gold On Request',
  typeSlug: 'gold',
  categorySlug: 'precious',
  mineralCode: 'AU',
  origin: { country: 'KE' },
  status: 'active',
  availableGrams: 0,
  minOrderGrams: 100,
  unitPriceMinorE4PerGram: 10_000,
  seller: { name: 'Mineral Bridge', tier: 'mineral_bridge', verified: true },
  attributes: { sourceSheet: true },
});

const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD', scale: 2 });
const { OrderModel } = await import('../src/models/order.model.js');
const { QuotationModel } = await import('../src/models/workflow.model.js');
const { auctionsService } = await import('../src/modules/auctions/auctions.service.js');

const revised = await OrderModel.create({
  reference: 'MB-ISO-QUOTE',
  userId: buyer._id,
  customerNo: 'C-6001',
  side: 'buy',
  status: 'active',
  source: { kind: 'admin' },
  workflow: { definition: 'buy.v2', stepKey: 'quoteOk', stepIndex: 2, owner: 'customer', role: 'customer', enteredAt: new Date() },
  lines: [{ name: 'Revised gold lot', productId: 'LOT-BR-1', grams: 1000, unitPriceMinorE4PerGram: 1, lineTotalMinor: 4500 }],
  totalGrams: 1000,
  subtotal: usd(4500),
  platformFee: usd(0),
  surcharge: usd(0),
  total: usd(4500),
  version: 2,
});
await QuotationModel.create({
  orderId: revised._id,
  number: 'Q-ISO-R2',
  rev: 2,
  lines: [],
  product: usd(4500),
  fee: usd(0),
  transport: usd(0),
  total: usd(4500),
  validUntil: new Date(Date.now() + 86_400_000),
  status: 'issued',
  issuedAt: new Date(),
  issuedBy: { kind: 'staff', id: 'staff-iso', name: 'Desk' },
});

await OrderModel.create({
  reference: 'MB-ISO-PAY',
  userId: buyer._id,
  customerNo: 'C-6001',
  side: 'buy',
  status: 'active',
  source: { kind: 'admin' },
  workflow: { definition: 'buy.v2', stepKey: 'paid', stepIndex: 5, owner: 'customer', role: 'customer', enteredAt: new Date() },
  lines: [{ name: 'Payment retry lot', productId: 'LOT-BR-1', grams: 1000, unitPriceMinorE4PerGram: 1, lineTotalMinor: 4500 }],
  totalGrams: 1000,
  subtotal: usd(4500),
  platformFee: usd(0),
  surcharge: usd(0),
  total: usd(4500),
  version: 4,
});

await OrderModel.create({
  reference: 'MB-ISO-SELL',
  userId: buyer._id,
  customerNo: 'C-6001',
  side: 'sell',
  status: 'active',
  source: { kind: 'app_sell_form' },
  workflow: { definition: 'sell.v2', stepKey: 'inspect', stepIndex: 2, owner: 'platform', role: 'inspection', enteredAt: new Date() },
  lines: [],
  totalGrams: 1000,
  subtotal: usd(0),
  platformFee: usd(0),
  surcharge: usd(0),
  total: usd(0),
  sell: { name: 'Iso gold dust', qty: { value: 1000, unit: 'kg', grams: 1000 }, grade: '80%' },
  version: 1,
});

await auctionsService.create({
  name: 'Iso Gold Auction',
  quantityGrams: 1000,
  startingBidMinor: 100_000,
  minimumIncrementMinor: 1_000,
  opensAt: new Date(Date.now() - 3_600_000),
  closesAt: new Date(Date.now() + 3_600_000),
  status: 'live',
});

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
