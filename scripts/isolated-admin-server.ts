/**
 * Dashboard browser check against an in-memory database.
 * Never reads the configured Atlas URI. Nothing here is written to production.
 */
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const repl = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
process.env.MONGODB_URI = repl.getUri('mb_dashboard_e2e');
/** development + DEV_OTP so customer OTP responses include developmentOtp for emulator/API E2E. */
process.env.NODE_ENV = 'development';
process.env.DEV_OTP_ENABLED = 'true';
process.env.PORT = '5011';
process.env.HOST = '127.0.0.1';
process.env.OTP_PROVIDER = 'fake';
process.env.EMAIL_PROVIDER = 'fake';
process.env.COOKIE_SECURE = 'false';
process.env.CORS_ADMIN_ORIGINS = 'http://127.0.0.1:5173,http://localhost:5173';
process.env.CORS_MOBILE_ORIGINS = '*';
process.env.LOG_LEVEL = 'warn';

const { connectDatabase } = await import('../src/config/database.js');
const { createApp } = await import('../src/app.js');
const { createStaff } = await import('../src/modules/staff/staff.service.js');

await connectDatabase();
await createStaff({
  email: 'ceo@mineralbridge.test',
  password: 'Correct-Horse-9!Battery',
  name: 'Platform CEO',
  roleId: 'ROLE-CEO',
});

const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD', scale: 2 });
const { UserModel } = await import('../src/modules/users/user.model.js');
const { ProductModel } = await import('../src/models/catalog.model.js');
const { OrderModel } = await import('../src/models/order.model.js');
const { PaymentModel, RefundModel } = await import('../src/models/workflow.model.js');
const { NotificationModel } = await import('../src/models/notification.model.js');
const { SupportTicketModel } = await import('../src/models/support.model.js');
const { ShipmentModel } = await import('../src/models/contract-lc.model.js');
const { KycSubmissionModel } = await import('../src/modules/kyc/kyc.model.js');
const { IssuedDocumentModel } = await import('../src/models/workflow.model.js');
const buyer = await UserModel.create({
  customerNo: 'C-5001',
  email: 'isolated.buyer@example.com',
  phone: '+254711500001',
  roles: ['both'],
  kycStatus: 'pending',
  accountStatus: 'active',
  profile: { fullName: 'Isolated Buyer', countryCode: 'KE' },
});
const lot = await ProductModel.create({
  reference: 'LOT-ISO-1',
  name: 'Isolated Gold',
  typeSlug: 'gold',
  categorySlug: 'precious',
  mineralCode: 'AU',
  origin: { country: 'KE' },
  status: 'active',
  availableGrams: 5000,
  minOrderGrams: 100,
  unitPriceMinorE4PerGram: 1,
  seller: { name: 'Mineral Bridge', tier: 'mineral_bridge', verified: true },
  attributes: {},
});
const order = await OrderModel.create({
  reference: 'MB-ORD-ISO-1',
  userId: String(buyer._id),
  customerNo: 'C-5001',
  side: 'buy',
  status: 'active',
  source: { kind: 'admin' },
  workflow: { definition: 'buy.v2', stepKey: 'quote', stepIndex: 1, owner: 'platform', role: 'trading', enteredAt: new Date() },
  lines: [{ name: 'Isolated Gold', productId: String(lot._id), grams: 1000, unitPriceMinorE4PerGram: 1, lineTotalMinor: 5000 }],
  totalGrams: 1000,
  subtotal: usd(5000),
  platformFee: usd(0),
  surcharge: usd(0),
  total: usd(5000),
  version: 1,
});
const payOrder = await OrderModel.create({
  reference: 'MB-ORD-ISO-PAY',
  userId: String(buyer._id),
  customerNo: 'C-5001',
  side: 'buy',
  status: 'active',
  source: { kind: 'admin' },
  workflow: { definition: 'buy.v2', stepKey: 'payOk', stepIndex: 8, owner: 'platform', role: 'finance', enteredAt: new Date() },
  lines: [{ name: 'Isolated Gold', productId: String(lot._id), grams: 100, unitPriceMinorE4PerGram: 1, lineTotalMinor: 1000 }],
  totalGrams: 100,
  subtotal: usd(1000),
  platformFee: usd(0),
  surcharge: usd(0),
  total: usd(1000),
  version: 1,
});
await PaymentModel.create({ orderId: String(payOrder._id), userId: String(buyer._id), method: 'bank_transfer', amount: usd(1000), status: 'submitted', attempt: 1, proofFileIds: [] });
await RefundModel.create({
  reference: 'MB-RF-ISO-1',
  orderId: String(order._id),
  userId: String(buyer._id),
  type: 'partial',
  amount: usd(1000),
  reason: 'other',
  note: 'Isolated refund.',
  destination: { method: 'original' },
  status: 'requested',
  decisions: [],
  approvals: [],
  dueBy: new Date(Date.now() + 86_400_000),
});
await KycSubmissionModel.create({
  publicId: 'kyc_iso_1',
  reference: 'MB-KYC-ISO-1',
  userId: buyer._id,
  status: 'pending',
  source: 'web',
  idTypeId: 'passport',
  requiredKinds: ['id_front'],
});
await NotificationModel.create({
  userId: String(buyer._id),
  kind: 'order',
  event: 'order.stage_changed',
  title: 'Payment update',
  body: 'Could not deliver',
  channels: ['email'],
  data: { deliveryStatus: 'failed', attempts: 1 },
});
await SupportTicketModel.create({
  reference: 'TCK-ISO-1',
  userId: String(buyer._id),
  topic: 'order',
  subject: 'Where is the shipment?',
  body: 'Please confirm the pickup date.',
  status: 'open',
  messages: [{ author: 'user', authorName: 'Isolated Buyer', body: 'Please confirm the pickup date.', attachmentIds: [], at: new Date() }],
  version: 0,
});
await ShipmentModel.create({
  reference: 'MB-SH-ISO-1',
  ownerIds: [String(buyer._id)],
  orderId: String(order._id),
  direction: 'vault_to_buyer',
  partnerId: 'PT-ISO',
  mode: ['road'],
  status: 'booked',
  progressPercent: 0,
  events: [],
  documents: [],
});
await IssuedDocumentModel.create({
  number: 'CN-ISO-1',
  type: 'consignment_note',
  entity: { type: 'order', id: 'MB-ORD-ISO-1' },
  userId: String(buyer._id),
  version: 1,
  status: 'issued',
  issuedBy: { kind: 'staff', id: 'ceo', name: 'Platform CEO' },
  issuedAt: new Date(),
});

const seller = await UserModel.create({
  customerNo: 'C-5002',
  email: 'isolated.seller@example.com',
  phone: '+254711500002',
  roles: ['both'],
  kycStatus: 'verified',
  accountStatus: 'active',
  profile: { fullName: 'Isolated Seller', countryCode: 'KE' },
});
await OrderModel.create({
  reference: 'MB-ORD-ISO-SELL',
  userId: String(seller._id),
  customerNo: 'C-5002',
  side: 'sell',
  status: 'active',
  source: { kind: 'admin' },
  workflow: { definition: 'sell.v2', stepKey: 'reviewed', stepIndex: 1, owner: 'platform', role: 'ops', enteredAt: new Date() },
  lines: [{ name: 'Isolated Gold', productId: String(lot._id), grams: 500, unitPriceMinorE4PerGram: 1, lineTotalMinor: 2500 }],
  totalGrams: 500,
  subtotal: usd(2500),
  platformFee: usd(0),
  surcharge: usd(0),
  total: usd(2500),
  sell: {
    mineralSlug: 'gold',
    name: 'Isolated Gold',
    qty: { measure: 'mass', unit: 'g', base: 500 },
    details: 'Isolated sell request for dashboard E2E.',
    photoFileIds: [],
    documentFileIds: [],
  },
  version: 1,
});

const app = createApp();
await new Promise<void>((resolve) => {
  app.listen(5011, '127.0.0.1', () => resolve());
});
console.log('ISOLATED_READY http://127.0.0.1:5011');
