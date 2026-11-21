import { MS_DAY, MS_HOUR } from '../shared/enums.js';
import { iso, isoDate } from '../shared/http.js';
import { partyFrom, staffFrom, type PartyRef, type StaffRef } from '../shared/refs.js';
import { escapeRegex } from '../shared/http.js';
import { User } from '../../../models/people.models.js';

export const KYC_SLA_MS = 48 * MS_HOUR;

export function maskEmail(email?: string | null): string {
  if (!email) return '';
  const [local = '', domain = ''] = email.split('@');
  const [host = '', ...tld] = domain.split('.');
  return `${local[0] ?? ''}***@${host[0] ?? ''}***${tld.length ? `.${tld.join('.')}` : ''}`;
}

export function maskPhoneNumber(phone?: string | null): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  return `${phone.startsWith('+') ? '+' : ''}${digits.slice(0, 3)} *** *** ${digits.slice(-3)}`;
}

/** Ids of users whose name or organisation contains `q` (used by cross-entity search boxes). */
export async function userIdsMatching(q: unknown, limit = 50): Promise<string[]> {
  if (typeof q !== 'string' || !q.trim()) return [];
  const re = new RegExp(escapeRegex(q.trim()), 'i');
  return (await User.find({ $or: [{ name: re }, { org: re }] }).limit(limit).lean()).map((u) => u.userId);
}

export function userSummaryDto(u: Record<string, any>, orderCount: number, pii: boolean) {  
  return {
    id: u.userId,
    name: u.name,
    org: u.org ?? '',
    email: pii ? u.email ?? '' : maskEmail(u.email),
    tier: u.tier,
    status: u.status,
    orderCount,
    joinedAt: iso(u.createdAt),
  };
}

export const daysToExpiry = (d?: Date | null): number | null => (d ? Math.ceil((d.getTime() - Date.now()) / MS_DAY) : null);

/** Stored status is the review state; expiry makes a verified document expiring (< 35 d) or expired. */
export function effectiveDocStatus(d: Record<string, any>): string {  
  const days = daysToExpiry(d.expiresOn);
  if (d.status === 'verified' && days !== null) {
    if (days < 0) return 'expired';
    if (days < 35) return 'expiring';
  }
  return d.status;
}

export function trackedDocumentDto(d: Record<string, any>, holders: Map<string, PartyRef>) {  
  return {
    id: d.docId,
    type: d.type,
    ref: d.ref ?? '',
    holder: partyFrom(holders, d.userId),
    tier: d.tier,
    expiresOn: d.expiresOn ? isoDate(d.expiresOn) : null,
    daysToExpiry: daysToExpiry(d.expiresOn),
    status: effectiveDocStatus(d),
    ...(d.fileId ? { fileId: d.fileId } : {}),
  };
}

export function ticketDto(t: Record<string, any>, users: Map<string, PartyRef>, staff: Map<string, StaffRef>) {  
  return {
    id: t.ticketId,
    subject: t.subject,
    user: partyFrom(users, t.userId),
    linked: t.linked?.id ? { type: t.linked.type, id: t.linked.id } : null,
    status: t.status,
    owner: t.ownerId ? staffFrom(staff, t.ownerId) : { team: t.ownerTeam ?? 'Support' },
    openedAt: iso(t.openedAt),
    ageHours: Math.max(0, Math.floor((Date.now() - new Date(t.openedAt).getTime()) / MS_HOUR)),
  };
}
