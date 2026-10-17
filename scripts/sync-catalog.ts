/**
 * Pull the mineral catalog from the configured Google Sheet.
 * A failed fetch writes a report and does not change the database.
 *
 *   npm run catalog:sync
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { loadEnv } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { CatalogAccessError, fetchCatalogCsv, syncCatalogFromCsv } from '../src/modules/catalog/sheet-sync.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const outDir = path.resolve(process.cwd(), 'reports');
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'catalog-sync-latest.json');
  try {
    const { csv, source } = await fetchCatalogCsv({
      sheetId: env.CATALOG_SHEET_ID || '1ptk_PuNT5UTXP7L_0I5s-C3PY4Px_0_a',
      gid: env.CATALOG_SHEET_GID || '1332939829',
      csvUrl: env.CATALOG_SHEET_CSV_URL,
    });
    if (process.argv.includes('--probe')) {
      const report = {
        fetchedAt: new Date().toISOString(),
        source,
        headers: [],
        imported: 0,
        skipped: 0,
        invalid: 0,
        unpublished: 0,
        accessError: 'probe only: CSV was fetched and was not written to the database',
        bytes: csv.length,
        rows: [],
      };
      writeFileSync(outFile, JSON.stringify(report, null, 2));
      logger.info({ outFile, bytes: csv.length }, 'catalog probe fetched CSV and did not write the database');
      return;
    }
    await connectDatabase();
    const report = await syncCatalogFromCsv(csv, source);
    writeFileSync(outFile, JSON.stringify(report, null, 2));
    logger.info({ outFile, imported: report.imported, accessError: report.accessError }, 'catalog sync report written');
    if (report.accessError) process.exitCode = 2;
  } catch (err) {
    const message = err instanceof CatalogAccessError ? err.message : err instanceof Error ? err.message : 'catalog sync failed';
    const report = {
      fetchedAt: new Date().toISOString(),
      source: env.CATALOG_SHEET_CSV_URL || env.CATALOG_SHEET_ID || '',
      headers: [],
      imported: 0,
      skipped: 0,
      invalid: 0,
      unpublished: 0,
      accessError: message,
      rows: [],
    };
    writeFileSync(outFile, JSON.stringify(report, null, 2));
    logger.error({ message }, 'catalog sync did not change the database');
    process.exitCode = 2;
  } finally {
    await disconnectDatabase().catch(() => undefined);
  }
}

void main();
