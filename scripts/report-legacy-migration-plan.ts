/**
 * Read-only: prints the 57 eligible legacy order mappings (and skip reasons).
 * Never writes to MongoDB.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { planLegacyCheckout, type LegacyCheckoutOrder } from '../src/modules/admin/v2/legacy-order-migration.js';
import { OrderModel } from '../src/models/order.model.js';
import { UserModel } from '../src/modules/users/user.model.js';

const db = (await connectDatabase()).connection.db;
if (!db) throw new Error('No database connection');

const batch = `legacy-${new Date().toISOString().slice(0, 10)}`;
const existing = new Set((await OrderModel.find({}, { reference: 1 }).lean()).map((o) => String(o.reference)));
const userIds = new Set((await UserModel.find({}, { _id: 1 }).lean()).map((u) => String(u._id)));
const source = await db.collection('orders').find({}).toArray();
const admCount = await db.collection('adm_orders').countDocuments({});
const custCount = await db.collection('cust_orders').countDocuments({});

const eligible: Record<string, unknown>[] = [];
const skipped: Record<string, unknown>[] = [];

for (const raw of source) {
  const plan = planLegacyCheckout(raw as LegacyCheckoutOrder, { existingRefs: existing, userIds, batch });
  if (plan.action === 'skip') {
    skipped.push({
      orderId: String((raw as { orderId?: string }).orderId ?? ''),
      reason: plan.reason,
      totalDue: (raw as { totalDue?: unknown }).totalDue ?? null,
      type: (raw as { type?: string }).type ?? null,
      unit: (raw as { unit?: string }).unit ?? null,
      quantity: (raw as { quantity?: number }).quantity ?? null,
    });
    continue;
  }
  const doc = plan.document;
  const migration = doc.migration as { totalDueOriginal: number; legacyId: string; batch: string };
  const total = doc.total as { amountMinor: number };
  const line = (doc.lines as Array<{ grams: number; name: string }>)[0];
  eligible.push({
    legacyId: migration.legacyId,
    orderId: plan.reference,
    userId: doc.userId,
    type: doc.side,
    statusLegacy: (raw as { status?: string }).status ?? null,
    statusTarget: doc.status,
    workflowStep: (doc.workflow as { stepKey: string }).stepKey,
    unit: (raw as { unit?: string }).unit ?? null,
    quantity: (raw as { quantity?: number }).quantity ?? null,
    grams: line?.grams ?? null,
    mineralName: line?.name ?? null,
    totalDueOriginal: migration.totalDueOriginal,
    amountMinor: total.amountMinor,
    currency: 'USD',
    scale: 2,
    targetCollection: 'cust_orders',
    migrationBatch: migration.batch,
    reversible: true,
  });
}

const outDir = path.resolve(process.cwd(), 'docs');
const report = {
  at: new Date().toISOString(),
  mode: 'preview-only',
  hostedWrite: false,
  counts: {
    legacyOrdersScanned: source.length,
    admOrdersUntouched: admCount,
    custOrdersExisting: custCount,
    eligibleWouldInsert: eligible.length,
    skipped: skipped.length,
  },
  skipReasons: skipped.reduce<Record<string, number>>((acc, row) => {
    const r = String(row.reason);
    acc[r] = (acc[r] ?? 0) + 1;
    return acc;
  }, {}),
  notes: [
    'amountMinor = round(totalDueOriginal * 100) treating totalDue as major units.',
    'No MongoDB inserts, updates, or deletes were performed.',
    'The 22 missing-totalDue rows and all adm_orders rows are excluded.',
  ],
  eligible,
  skipped,
};

await mkdir(outDir, { recursive: true });
const jsonPath = path.join(outDir, 'Legacy_Orders_Migration_Preview.json');
const mdPath = path.join(outDir, 'Legacy_Orders_Migration_Preview.md');
await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');

const lines = [
  '# Legacy orders migration preview (no write)',
  '',
  `Generated: ${report.at}`,
  '',
  '## Counts',
  '',
  `| Item | Count |`,
  `| --- | ---: |`,
  `| Legacy \`orders\` scanned | ${report.counts.legacyOrdersScanned} |`,
  `| Eligible for insert into \`cust_orders\` | ${report.counts.eligibleWouldInsert} |`,
  `| Skipped | ${report.counts.skipped} |`,
  `| Existing \`cust_orders\` | ${report.counts.custOrdersExisting} |`,
  `| \`adm_orders\` (untouched) | ${report.counts.admOrdersUntouched} |`,
  '',
  '## Skip reasons',
  '',
  ...Object.entries(report.skipReasons).map(([k, v]) => `- ${k}: ${v}`),
  '',
  '## Eligible records (57)',
  '',
  '| orderId | side | totalDue (major) | amountMinor | grams | unit | target step | status |',
  '| --- | --- | ---: | ---: | ---: | --- | --- | --- |',
  ...eligible.map((e) =>
    `| ${e.orderId} | ${e.type} | ${e.totalDueOriginal} | ${e.amountMinor} | ${e.grams} | ${e.unit} | ${e.workflowStep} | ${e.statusTarget} |`),
  '',
  'Full JSON (includes userId, legacyId, mineralName): `docs/Legacy_Orders_Migration_Preview.json`',
  '',
  '**No migration was executed.**',
];
await writeFile(mdPath, lines.join('\n'), 'utf8');

console.log(JSON.stringify({
  wrote: { jsonPath, mdPath },
  counts: report.counts,
  skipReasons: report.skipReasons,
}, null, 2));

await disconnectDatabase();
