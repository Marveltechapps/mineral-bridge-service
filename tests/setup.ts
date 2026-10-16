/**
 * Global vitest setup.
 *
 * - Forces NODE_ENV=test and deterministic, quiet providers.
 * - Provides mongodb-memory-server (a single-node replica set, so transactions work).
 *   Most unit tests in this repo are DB-free, so the server is NOT started for every file.
 *   Opt in per test file with `useMemoryMongo()`, or for every file with `TEST_DB=memory`.
 */
import { afterAll, beforeAll } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
process.env.OTP_PROVIDER = 'fake';
process.env.EMAIL_PROVIDER = 'fake';
process.env.COOKIE_SECURE = 'false';

type ReplSet = import('mongodb-memory-server').MongoMemoryReplSet;
let replSet: ReplSet | null = null;

/** Start (once) an in-memory replica set and point MONGODB_URI at it. Returns the URI. */
export async function startMemoryReplSet(dbName = 'mineralbridge_test'): Promise<string> {
  if (!replSet) {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  }
  const uri = replSet.getUri(dbName);
  process.env.MONGODB_URI = uri;
  return uri;
}

export async function stopMemoryReplSet(): Promise<void> {
  if (replSet) await replSet.stop();
  replSet = null;
}

/** Call at the top of a test file that needs a real MongoDB. Connect with `connectDb()` afterwards. */
export function useMemoryMongo(dbName?: string): void {
  beforeAll(async () => {
    await startMemoryReplSet(dbName);
  }, 120_000);
  afterAll(stopMemoryReplSet);
}

if (process.env.TEST_DB === 'memory') useMemoryMongo();