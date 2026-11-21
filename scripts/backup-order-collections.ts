/**
 * Read-only backup of orders / adm_orders / cust_orders from the configured database.
 * Writes JSON files under backups/ — never inserts, updates, or deletes MongoDB documents.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.resolve(process.cwd(), 'backups', `orders-${stamp}`);
await mkdir(outDir, { recursive: true });

const db = (await connectDatabase()).connection.db;
if (!db) throw new Error('No database connection');

const names = ['orders', 'adm_orders', 'cust_orders'] as const;
const summary: Record<string, number> = {};
for (const name of names) {
  const rows = await db.collection(name).find({}).toArray();
  summary[name] = rows.length;
  await writeFile(path.join(outDir, `${name}.json`), JSON.stringify(rows, null, 2), 'utf8');
}

const meta = {
  at: new Date().toISOString(),
  directory: outDir,
  counts: summary,
  note: 'Read-only export. No MongoDB writes were performed.',
};
await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(meta, null, 2), 'utf8');
console.log(JSON.stringify(meta, null, 2));
await disconnectDatabase();
