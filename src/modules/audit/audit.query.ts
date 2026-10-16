import { badRequest } from '../../common/errors/app-error.js';
import { AUDIT_CATEGORIES } from '../admin/shared/enums.js';
import { dateQ, escapeRegex, oneOf } from '../admin/shared/http.js';

export const AUDIT_SORT: Record<string, string> = { at: 'at', actor: 'actor.name', action: 'action', record: 'record.id' };

/** Filter builder for #123 and for #124 exports (same query contract). */
export function buildAuditFilter(query: Record<string, unknown>): Record<string, unknown> {
  const and: Record<string, unknown>[] = [];
  const category = oneOf(query.category, AUDIT_CATEGORIES, 'category');
  if (category) and.push({ category });
  if (typeof query.actorId === 'string' && query.actorId) and.push({ 'actor.staffId': query.actorId });
  if (typeof query.recordType === 'string' && query.recordType) and.push({ 'record.type': query.recordType });
  if (typeof query.recordId === 'string' && query.recordId) and.push({ 'record.id': query.recordId });
  const from = dateQ(query.from, 'from');
  const to = dateQ(query.to, 'to');
  if (from || to) and.push({ at: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } });
  if (from && to && from > to) throw badRequest('request/malformed', '`from` must be before `to`');
  if (typeof query.q === 'string' && query.q.trim()) {
    const re = new RegExp(escapeRegex(query.q.trim()), 'i');
    and.push({
      $or: [{ 'actor.name': re }, { 'actor.role': re }, { action: re }, { 'record.id': re }, { 'record.label': re }, { beforeText: re }, { afterText: re }],
    });
  }
  return and.length ? { $and: and } : {};
}

export function auditEntryDto(a: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any{
  return {
    id: a.auditId,
    at: a.at.toISOString(),
    actor: { id: a.actor?.staffId ?? 'system', name: a.actor?.name ?? 'System', initials: a.actor?.initials ?? 'SY', role: a.actor?.role ?? 'System' },
    action: a.action,
    category: a.category,
    record: { type: a.record.type, id: a.record.id, label: a.record.label ?? a.record.id },
    before: a.beforeText ?? '—',
    after: a.afterText ?? '—',
    ...(a.reason ? { reason: a.reason } : {}),
  };
}
