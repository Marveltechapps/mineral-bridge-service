/**
 * Read-only connectivity check. Counts documents and pings the server.
 * It does not insert, update, or delete anything.
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';

const db = (await connectDatabase()).connection.db;
if (!db) throw new Error('Database connection has no handle');

const ping = await db.admin().command({ ping: 1 });
const names = (await db.listCollections().toArray()).map((c) => c.name).sort();
const counts: Record<string, number> = {};
for (const name of names) counts[name] = await db.collection(name).countDocuments();

console.log(JSON.stringify({
  ok: ping.ok === 1,
  database: db.databaseName,
  readOnly: true,
  collections: names.length,
  counts,
}, null, 2));

await disconnectDatabase();
void mongoose;
