import { notFound } from '../../../common/errors/app-error.js';
import { StaffModel } from '../../staff/staff.model.js';
import { initialsOf } from './staff-context.js';
import { User } from '../../../models/people.models.js';
import { Partner } from '../../../models/content.models.js';

export type StaffRef = { id: string; name: string; initials: string; role: string };
export type PartyRef = { id: string; name: string; org?: string; tier?: 1 | 2 | 3 };

const uniq = (ids: Array<string | null | undefined>): string[] => [...new Set(ids.filter((x): x is string => Boolean(x)))];

export async function loadStaffMap(ids: Array<string | null | undefined>): Promise<Map<string, StaffRef>> {
  const list = uniq(ids);
  const map = new Map<string, StaffRef>();
  if (!list.length) return map;
  const staff = await StaffModel.find({ publicId: { $in: list } }).lean();
  for (const s of staff) {
    map.set(s.publicId, { id: s.publicId, name: s.name, initials: initialsOf(s.name), role: s.role?.name ?? '' });
  }
  return map;
}

export async function loadUserMap(ids: Array<string | null | undefined>): Promise<Map<string, PartyRef>> {
  const list = uniq(ids);
  const map = new Map<string, PartyRef>();
  if (!list.length) return map;
  const users = await User.find({ userId: { $in: list } }).lean();
  for (const u of users) map.set(u.userId, partyOf(u));
  return map;
}

export function partyOf(u: Record<string, any>): PartyRef { // eslint-disable-line @typescript-eslint/no-explicit-any
  return { id: u.userId, name: u.name, ...(u.org ? { org: u.org } : {}), ...(u.tier ? { tier: u.tier as 1 | 2 | 3 } : {}) };
}

export const unknownParty = (id: string): PartyRef => ({ id, name: id });

export function partyFrom(map: Map<string, PartyRef>, id: string | null | undefined): PartyRef | null {
  if (!id) return null;
  return map.get(id) ?? unknownParty(id);
}

export function staffFrom(map: Map<string, StaffRef>, id: string | null | undefined): StaffRef | null {
  if (!id) return null;
  return map.get(id) ?? { id, name: id, initials: '??', role: '' };
}

export async function requireUser(userId: string) {
  const u = await User.findOne({ userId }).lean();
  if (!u) throw notFound('resource/not-found', `User ${userId} not found`);
  return u;
}

export async function loadPartnerMap(ids: Array<string | null | undefined>) {
  const list = uniq(ids);
  const map = new Map<string, { id: string; name: string; type: string }>();
  if (!list.length) return map;
  for (const p of await Partner.find({ partnerId: { $in: list } }).lean()) map.set(p.partnerId, { id: p.partnerId, name: p.name, type: p.type });
  return map;
}

/** Utility for mapping lists in handlers. */
export async function withRefs<D>(docs: D[], staffIds: (d: D) => Array<string | null | undefined>, userIds: (d: D) => Array<string | null | undefined>) {
  const [staff, users] = await Promise.all([loadStaffMap(docs.flatMap(staffIds)), loadUserMap(docs.flatMap(userIds))]);
  return { staff, users };
}
