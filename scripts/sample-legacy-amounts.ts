/**
 * Read-only. Prints numeric ranges for legacy checkout orders.
 * Does not print customer identifiers and does not write.
 */
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';

const db = (await connectDatabase()).connection.db;
if (!db) throw new Error('No database connection');

function stats(values: number[]) {
  if (!values.length) return { count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return {
    count: values.length,
    min: sorted[0],
    median: mid,
    max: sorted[sorted.length - 1],
    decimals: values.filter((n) => !Number.isInteger(n)).length,
    aboveTenThousand: values.filter((n) => n >= 10_000).length,
  };
}

const rows = await db.collection('orders').find({}, { projection: { totalDue: 1, amount: 1, subtotal: 1, quantity: 1, unit: 1, type: 1 } }).toArray();
const numberOf = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
};
const totalDue = rows.map((row) => numberOf(row.totalDue)).filter((n): n is number => n != null);
const amount = rows.map((row) => numberOf(row.amount)).filter((n): n is number => n != null);
const subtotal = rows.map((row) => numberOf(row.subtotal)).filter((n): n is number => n != null);
const both = rows.filter((row) => numberOf(row.totalDue) != null && numberOf(row.amount) != null);
const ratio = both.map((row) => {
  const due = numberOf(row.totalDue)!;
  const raw = numberOf(row.amount)!;
  return raw === 0 ? null : Math.round((due / raw) * 100) / 100;
}).filter((n): n is number => n != null);

console.log(JSON.stringify({
  collection: 'orders',
  scanned: rows.length,
  totalDue: stats(totalDue),
  amount: stats(amount),
  subtotal: stats(subtotal),
  totalDueOverAmount: stats(ratio),
  sampleUnits: [...new Set(rows.map((row) => String(row.unit ?? '')))].slice(0, 8),
  sampleTypes: [...new Set(rows.map((row) => String(row.type ?? '')))].slice(0, 8),
  assumption: 'The planner treats totalDue as major units (amountMinor = round(totalDue * 100)). This script does not write.',
}, null, 2));

await disconnectDatabase();
