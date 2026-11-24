/**
 * Read-only counts against the configured database. Never writes.
 * Prints aggregate numbers only. Connection strings are redacted.
 */
import { MongoClient } from 'mongodb';
import { config as loadDotenv } from 'dotenv';

loadDotenv();

const uri = process.env.MONGO_URI || process.env.MONGODB_URI || '';
const redact = (text) => String(text).replace(/mongodb(\+srv)?:\/\/[^\s'"]+/gi, 'mongodb://redacted');

if (!uri) {
  console.log(JSON.stringify({ ok: false, blocked: 'no database URI in the environment' }));
  process.exit(2);
}

const remote = uri.startsWith('mongodb+srv://') || !/(localhost|127\.0\.0\.1)/.test(uri);
const client = new MongoClient(uri, {
  readPreference: 'secondaryPreferred',
  serverSelectionTimeoutMS: 12_000,
  retryWrites: false,
});

try {
  await client.connect();
  const db = client.db();
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort();
  const counts = {};
  for (const name of names) counts[name] = await db.collection(name).countDocuments({});
  const orders = db.collection('cust_orders');
  const products = db.collection('cust_products');
  const kycDocs = db.collection('kycdocuments');
  const [orderCount, productCount, sold, onRequest, gramsAsKg, zeroQty, idBack, sheetZero, inventoryZero, sellOrders, auctions, payments, quotes] = await Promise.all([
    orders.countDocuments({}),
    products.countDocuments({}),
    products.countDocuments({ status: 'sold' }),
    products.countDocuments({ status: 'active', availableGrams: { $lte: 0 } }),
    orders.countDocuments({ 'sell.qty.unit': 'kg', $expr: { $eq: ['$sell.qty.value', '$sell.qty.grams'] } }),
    orders.countDocuments({ 'sell.qty.unit': 'kg', 'sell.qty.value': 0, 'sell.qty.grams': { $gt: 0 } }),
    kycDocs.countDocuments({ kind: 'id_back' }),
    products.countDocuments({ status: 'active', availableGrams: { $lte: 0 }, 'attributes.sourceSheet': true }),
    products.countDocuments({ status: 'active', availableGrams: { $lte: 0 }, 'attributes.sourceSheet': { $ne: true } }),
    orders.countDocuments({ side: 'sell' }),
    db.collection('cust_auctions').countDocuments({}),
    db.collection('cust_payments').countDocuments({}),
    db.collection('cust_quotations').countDocuments({}),
  ]);
  const statuses = await products.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
  console.log(JSON.stringify({
    ok: true,
    remote,
    collections: counts,
    writes: 0,
    orderCount,
    productCount,
    productStatuses: Object.fromEntries(statuses.map((row) => [String(row._id), row.n])),
    soldProducts: sold,
    activeZeroGramProducts: onRequest,
    sellQtyValueEqualsGrams: gramsAsKg,
    sellQtyZeroWithGrams: zeroQty,
    kycIdBackDocuments: idBack,
    activeZeroGramSheetRows: sheetZero,
    activeZeroGramInventoryLots: inventoryZero,
    sellOrders,
    auctions,
    payments,
    quotes,
  }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, remote, error: redact(err?.message || err).slice(0, 400) }));
  process.exit(1);
} finally {
  await client.close().catch(() => undefined);
}
