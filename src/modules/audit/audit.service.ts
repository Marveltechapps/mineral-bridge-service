import type { Request } from 'express';
import type { ClientSession } from 'mongoose';
import { nextId } from '../../common/db/sequence.js';
import type { AuditCategory } from '../admin/shared/enums.js';
import { ActivityEvent } from '../../models/platform.models.js';
import { AuditLog } from './audit.model.js';

export type AuditActor = { staffId: string; name: string; initials?: string; role?: string; roleId?: string };

export type AuditInput = {
  actor: AuditActor | null | undefined;
  category: AuditCategory;
  action: string;
  record: { type: string; id: string; label?: string };
  before?: unknown;
  after?: unknown;
  reason?: string;
  req?: Pick<Request, 'requestId' | 'ip'>;
  session?: ClientSession;
  /** Also append an Overview "Recent activity" row. */
  activity?: { text: string; meta?: string; kind?: string; severity?: 'info' | 'warn' | 'error'; ref?: { type: string; id: string } };
};

const SECRET_KEY = /pass(word)?|token|secret|hash|otp|pin$/i;

function redact(value: unknown, depth = 0): unknown {
  if (value == null || depth > 4) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Short display string for the audit table's before/after columns. */
export function summarize(value: unknown): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'string') return value || '—';
  if (typeof value !== 'object') return String(value);
  const v = redact(value) as Record<string, unknown>;
  const parts = Object.entries(v).map(([k, x]) => `${k}: ${typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x)}`);
  const text = parts.join(' · ');
  return text.length > 400 ? `${text.slice(0, 397)}…` : text || '—';
}

/**
 * Appends one audit row (and optionally an activity row). Returns the AUD-… id for ActionResult.auditId.
 * Pass `session` so the audit row commits atomically with the business write.
 */
export async function recordAudit(input: AuditInput): Promise<string> {
  const auditId = await nextId('audit');
  const actor = input.actor
    ? { staffId: input.actor.staffId, name: input.actor.name, initials: input.actor.initials, role: input.actor.role, roleId: input.actor.roleId }
    : { staffId: 'system', name: 'System', initials: 'SY', role: 'System' };
  await AuditLog.create(
    [
      {
        auditId,
        at: new Date(),
        actor,
        category: input.category,
        action: input.action,
        record: input.record,
        before: redact(input.before),
        after: redact(input.after),
        beforeText: summarize(input.before),
        afterText: summarize(input.after),
        reason: input.reason,
        requestId: input.req?.requestId,
        ip: input.req?.ip,
      },
    ],
    { session: input.session },
  );
  if (input.activity) {
    await ActivityEvent.create(
      [
        {
          activityId: await nextId('activity'),
          text: input.activity.text,
          meta: input.activity.meta,
          kind: input.activity.kind ?? input.record.type,
          severity: input.activity.severity ?? 'info',
          ref: input.activity.ref ?? { type: input.record.type, id: input.record.id },
          at: new Date(),
        },
      ],
      { session: input.session },
    );
  }
  return auditId;
}

export async function countAuditEntries(): Promise<number> {
  return AuditLog.estimatedDocumentCount();
}
