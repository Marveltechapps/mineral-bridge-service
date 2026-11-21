/** Read-only field names for the order collections. Prints keys, never values. */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';

function shape(value: unknown, depth = 0): unknown {
  if (value == null || depth > 2) return value === null ? 'null' : typeof value;
  if (Array.isArray(value)) return value.length ? [shape(value[0], depth + 1)] : ['empty'];
  if (value instanceof Date) return 'date';
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object)) {
      if (key === '__v') continue;
      out[key] = shape((value as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  }
  return typeof value;
}

const db = (await connectDatabase()).connection.db;
if (!db) throw new Error('no database');
const names = ['orders', 'adm_orders', 'cust_orders'];
const report: Record<string, unknown> = {};
for (const name of names) {
  const col = db.collection(name);
  const count = await col.countDocuments();
  const sample = await col.find({}, { projection: { email: 0, phone: 0, whatsapp: 0 } }).limit(1).next();
  report[name] = { count, shape: sample ? shape(sample) : null };
}
console.log(JSON.stringify(report, null, 2));
await disconnectDatabase();
void mongoose;
