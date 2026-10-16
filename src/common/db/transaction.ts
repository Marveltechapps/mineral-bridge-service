import mongoose, { type ClientSession } from 'mongoose';
import { logger } from '../../config/logger.js';

let supportsTx: boolean | null = null;

async function detectTransactionSupport(): Promise<boolean> {
  if (supportsTx !== null) return supportsTx;
  try {
    const db = mongoose.connection.db;
    if (!db) return false;
    const hello = (await db.admin().command({ hello: 1 })) as { setName?: string; msg?: string };
    supportsTx = Boolean(hello.setName) || hello.msg === 'isdbgrid';
  } catch {
    supportsTx = false;
  }
  if (!supportsTx) {
    logger.warn('MongoDB is not a replica set: multi-document writes run WITHOUT transactions. Use docker-compose replica set for production.');
  }
  return supportsTx;
}

export function resetTransactionSupportCache(): void {
  supportsTx = null;
}

/**
 * Runs `fn` inside a MongoDB transaction when the deployment supports it
 * (replica set / mongos). On a standalone mongod (dev only) it runs without a session.
 */
export async function withTx<T>(fn: (session: ClientSession | undefined) => Promise<T>): Promise<T> {
  if (!(await detectTransactionSupport())) return fn(undefined);
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
