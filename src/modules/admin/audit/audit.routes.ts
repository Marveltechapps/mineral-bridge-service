import { z } from 'zod';
import { auditActor, staffActor } from '../shared/staff-context.js';
import { AuditLog } from '../../audit/audit.model.js';
import { AUDIT_SORT, auditEntryDto, buildAuditFilter } from '../../audit/audit.query.js';
import { recordAudit } from '../../audit/audit.service.js';
import { queueExport } from '../exports/exports.service.js';
import { action, pageOf, paging, sortSpec } from '../shared/http.js';
import { route, type AdminRouteDef } from '../shared/route-kit.js';

const RETENTION_YEARS = 7;

export const auditRoutes: AdminRouteDef[] = [
  route(123, 'GET /audit-log', ['settings', 'view'], async (req, res) => {
    const filter = buildAuditFilter(req.query);
    const page = await pageOf(AuditLog, {
      filter,
      sort: sortSpec(req, AUDIT_SORT, { at: -1, _id: -1 }),
      paging: paging(req),
      map: (docs: Parameters<typeof auditEntryDto>[0][]) => docs.map(auditEntryDto),
      extraMeta: async () => ({ totalUnfiltered: await AuditLog.estimatedDocumentCount(), retentionYears: RETENTION_YEARS }),
    });
    res.json(page);
  }),

  route(124, 'POST /audit-log/exports', ['settings', 'view'], async (req, res) => {
    const a = staffActor(req);
    const { filters, format } = req.body as { filters: Record<string, unknown>; format: 'csv' | 'jsonl' };
    buildAuditFilter(filters); // validate early so bad filters fail with 4xx, not in the worker
    const exportId = await queueExport({ kind: 'audit_log', format, filters, requestedBy: a.staffId });
    const auditId = await recordAudit({
      actor: auditActor(req),
      category: 'compliance',
      action: 'Queued audit log export',
      record: { type: 'document', id: exportId, label: `Audit log export (${format})` },
      after: { filters, format },
      req,
    });
    res.status(202).json({ ...action({ exportId }, 'Audit log export queued — you will get an email', auditId), exportId, message: 'Audit log export queued — you will get an email' });
  }, { body: z.object({ filters: z.record(z.unknown()).default({}), format: z.enum(['csv', 'jsonl']).default('csv') }) }),
];
