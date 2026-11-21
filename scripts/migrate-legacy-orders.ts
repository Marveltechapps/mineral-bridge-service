/**
 * Dry-run by default.
 * `--write` inserts planned rows into cust_orders on a local database only.
 * A hosted URI (mongodb.net / mongodb+srv) is refused even with --write.
 * Existing cust_orders rows are never updated or deleted. Source rows are never deleted.
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { hostedDatabase, planLegacyCheckout, type LegacyCheckoutOrder } from '../src/modules/admin/v2/legacy-order-migration.js';
import { OrderModel } from '../src/models/order.model.js';
import { UserModel } from '../src/modules/users/user.model.js';

const write = process.argv.includes('--write');
const uri = process.env.MONGODB_URI || process.env.MONGO_URI || '';
if (write && hostedDatabase(uri)) {
  console.error('Refusing to write. The configured database is hosted. Run without --write to print the plan.');
  process.exit(2);
}

const db = (await connectDatabase()).connection.db;
if (!db) throw new Error('No database connection');
const batch = `legacy-${new Date().toISOString().slice(0, 10)}`;
const existing = new Set((await OrderModel.find({}, { reference: 1 }).lean()).map((o) => String(o.reference)));
const userIds = new Set((await UserModel.find({}, { _id: 1 }).lean()).map((u) => String(u._id)));
const source = await db.collection('orders').find({}).toArray();

let insert = 0;
let skip = 0;
const reasons: Record<string, number> = {};
for (const raw of source) {
  const plan = planLegacyCheckout(raw as LegacyCheckoutOrder, { existingRefs: existing, userIds, batch });
  reasons[plan.action === 'skip' ? plan.reason : 'insert'] = (reasons[plan.action === 'skip' ? plan.reason : 'insert'] ?? 0) + 1;
  if (plan.action === 'skip') {
    skip += 1;
    continue;
  }
  insert += 1;
  if (write) {
    await OrderModel.create(plan.document);
    existing.add(plan.reference);
  }
}

console.log(JSON.stringify({
  mode: write ? 'write' : 'dry-run',
  source: 'orders',
  target: 'cust_orders',
  scanned: source.length,
  wouldInsert: insert,
  skipped: skip,
  reasons,
  batch,
  hostedWriteBlocked: hostedDatabase(uri),
}, null, 2));

await disconnectDatabase();
void mongoose;
