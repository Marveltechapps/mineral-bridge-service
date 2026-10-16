import { nextId } from '../../../common/db/sequence.js';
import { sendMail } from '../../../common/notify/mailer.js';
import { logger } from '../../../config/logger.js';
import { ExportJob } from '../../../models/platform.models.js';
import { Order } from '../../../models/trading.models.js';
import { StaffModel } from '../../staff/staff.model.js';
import { AuditLog } from '../../audit/audit.model.js';
import { AUDIT_SORT, auditEntryDto, buildAuditFilter } from '../../audit/audit.query.js';
import { writeStoredFile } from '../../storage/storage.service.js';
import { buildOrderFilter, ORDER_STAGE_LABEL } from '../orders/orders.service.js';
import { toCsv } from '../shared/http.js';
import { loadStaffMap, loadUserMap } from '../shared/refs.js';
import { outQty } from '../shared/money.js';

export const ORDER_EXPORT_SYNC_LIMIT = 10_000;

export async function queueExport(input: { kind: 'audit_log' | 'orders'; format: 'csv' | 'jsonl'; filters: Record<string, unknown>; requestedBy: string }) {
  const exportId = await nextId('exportJob');
  await ExportJob.create({ exportId, kind: input.kind, format: input.format, filters: input.filters, requestedBy: input.requestedBy, status: 'queued' });
  // Best-effort in-process worker. A dedicated worker can call runExportJob() on `queued` rows instead.
  setImmediate(() => {
    void runExportJob(exportId).catch((err) => logger.error({ err, exportId }, 'Export job failed'));
  });
  return exportId;
}

export async function runExportJob(exportId: string): Promise<void> {
  const job = await ExportJob.findOneAndUpdate({ exportId, status: 'queued' }, { $set: { status: 'running' } }, { new: true }).lean();
  if (!job) return;
  try {
    let body = '';
    let rows = 0;
    if (job.kind === 'audit_log') {
      const docs = await AuditLog.find(buildAuditFilter(job.filters ?? {})).sort({ [AUDIT_SORT.at!]: -1 }).limit(200_000).lean();
      rows = docs.length;
      if (job.format === 'jsonl') body = docs.map((d) => JSON.stringify({ ...auditEntryDto(d), beforeData: d.before, afterData: d.after })).join('\n');
      else {
        body = toCsv(
          ['id', 'at', 'actor', 'role', 'action', 'category', 'record_type', 'record_id', 'before', 'after', 'reason'],
          docs.map((d) => [d.auditId, d.at, d.actor?.name, d.actor?.role, d.action, d.category, d.record?.type, d.record?.id, d.beforeText, d.afterText, d.reason]),
        );
      }
    } else {
      const { filter } = await buildOrderFilter(job.filters ?? {});
      const docs = await Order.find(filter).sort({ openedAt: -1 }).limit(200_000).lean();
      rows = docs.length;
      const [users, staff] = await Promise.all([loadUserMap(docs.map((d) => d.counterpartyId)), loadStaffMap(docs.map((d) => d.agentId))]);
      body = toCsv(
        ['id', 'side', 'mineral', 'party', 'quantity', 'unit', 'stage', 'agent', 'opened_at'],
        docs.map((o) => [o.orderId, o.side, o.mineral?.name, users.get(o.counterpartyId)?.name, outQty(o.quantity)?.value, o.quantity?.unit, ORDER_STAGE_LABEL[o.stage as keyof typeof ORDER_STAGE_LABEL], staff.get(o.agentId)?.name, o.openedAt]),
      );
    }
    const storageKey = `exports/${exportId}.${job.format === 'jsonl' ? 'jsonl' : 'csv'}`;
    await writeStoredFile(storageKey, body);
    await ExportJob.updateOne({ exportId }, { $set: { status: 'ready', rowCount: rows, storageKey } });
    const requester = await StaffModel.findOne({ publicId: job.requestedBy }).lean();
    if (requester) {
      try {
        await sendMail(requester.email, `Your ${job.kind.replace('_', ' ')} export is ready`, `Export ${exportId} (${rows} rows) is ready in the admin console.`);
        await ExportJob.updateOne({ exportId }, { $set: { notifiedAt: new Date() } });
      } catch (err) {
        logger.warn({ err, exportId }, 'Export ready but email could not be sent');
      }
    }
  } catch (err) {
    await ExportJob.updateOne({ exportId }, { $set: { status: 'failed', error: err instanceof Error ? err.message : String(err) } });
    throw err;
  }
}
