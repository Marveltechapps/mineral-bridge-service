/**
 * One-shot initializer. Normal startup runs the same code, so this is optional.
 *
 *   npm run seed
 *   SEED_ONLY=admin npm run seed
 *
 * Inserts missing defaults only. Does not reset passwords or rewrite existing rows.
 * Sample catalogue and the development admin password are limited to a local development database.
 */
import 'dotenv/config';
import { initializeDatabase } from '../src/bootstrap/initialize-database.js';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { loadEnv } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';

async function main(): Promise<void> {
  const env = loadEnv();
  await connectDatabase(env.MONGODB_URI);
  const report = await initializeDatabase({
    trigger: 'cli',
    nodeEnv: env.NODE_ENV,
    mongoUri: env.MONGODB_URI,
  });
  if (report.skipped) logger.info({ reason: report.reason }, 'Seed skipped');
  await disconnectDatabase();
}

main().catch(async (err) => {
  logger.error({ err }, 'Seed failed');
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
