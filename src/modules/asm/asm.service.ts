import { conflict, notFound, unprocessable } from '../../common/errors/app-error.js';
import { now } from '../../common/utils/clock.js';
import { references } from '../../common/utils/references.js';
import { StateMachine } from '../../common/utils/state-machine.js';
import { AsmRegistrationModel } from '../../models/web-trade.model.js';
import type { AsmDocKey, AsmStatus, IAsmRegistration } from '../../models/web-trade.model.js';
import { notifyUser } from '../notifications/notifications.service.js';
import { uploadsService } from '../uploads/uploads.service.js';

export const asmMachine = new StateMachine<AsmStatus>(
  'asm-registration',
  {
    draft: ['submitted'],
    submitted: ['visit_scheduled', 'rejected'],
    visit_scheduled: ['approved', 'rejected'],
    approved: [],
    rejected: [],
  },
  'asm/invalid-transition',
);

export const ELIGIBILITY_QUESTIONS = [
  { index: 0, text: 'Are you at least 18 years old?', required: true },
  { index: 1, text: 'Do you work (or intend to work) at a registered or licensable artisanal site?', required: false },
  { index: 2, text: 'Are you free of any ban on trading minerals?', required: true },
  { index: 3, text: 'Do you agree to responsible-sourcing checks, including site visits?', required: true },
  { index: 4, text: 'Does your production exclude conflict-affected or child-labour sources?', required: true },
] as const;

const DOC_KEYS: AsmDocKey[] = ['id', 'licence', 'photos'];

/** Pure: eligible when every required answer is yes and at most one optional question is no. */
export function evaluateEligibility(answers: { index: number; answer: boolean }[]): { met: boolean; failed: number[] } {
  const byIndex = new Map(answers.map((a) => [a.index, a.answer]));
  const failed = ELIGIBILITY_QUESTIONS.filter((q) => byIndex.get(q.index) !== true).map((q) => q.index);
  const requiredFailed = ELIGIBILITY_QUESTIONS.some((q) => q.required && failed.includes(q.index));
  return { met: !requiredFailed && failed.length <= 1, failed };
}

/** Coarse region label; real reverse-geocoding is a vendor integration. */
export function gpsRegionLabel(lat: number, lng: number): string {
  return `${lat >= 0 ? 'N' : 'S'}${Math.abs(Math.round(lat))}/${lng >= 0 ? 'E' : 'W'}${Math.abs(Math.round(lng))}`;
}

const emptyDocs = () => DOC_KEYS.map((key) => ({ key, fileIds: [] as string[], status: 'missing' as const }));

export function missingForSubmit(r: IAsmRegistration): string[] {
  const missing: string[] = [];
  if (!r.eligibilityMet) missing.push('eligibility');
  if (!r.site?.name || !r.site.country || !r.site.minerals?.length) missing.push('site');
  if (!r.gps) missing.push('gps');
  for (const d of r.documents) if (d.fileIds.length === 0) missing.push(`documents.${d.key}`);
  return missing;
}

export const asmService = {
  eligibilityQuestions: () => ELIGIBILITY_QUESTIONS,

  async create(userId: string, answers: { index: number; answer: boolean }[]) {
    const open = await AsmRegistrationModel.findOne({ userId, status: { $in: ['draft', 'submitted', 'visit_scheduled'] } }).lean<IAsmRegistration>();
    if (open) throw conflict('asm/already-open', 'You already have an open registration.', { current: { id: open._id } } as never);
    const ev = evaluateEligibility(answers);
    if (!ev.met) throw unprocessable('You do not meet the eligibility requirements', { eligibilityAnswers: 'Not eligible' }, 'asm/not-eligible');
    const doc = await AsmRegistrationModel.create({
      userId,
      status: 'draft',
      step: 'site',
      eligibilityAnswers: answers,
      eligibilityMet: true,
      site: { minerals: [], workerCount: 0 },
      documents: emptyDocs(),
      version: 0,
    });
    return doc.toObject() as IAsmRegistration;
  },

  async get(userId: string, id: string): Promise<IAsmRegistration> {
    const r = await AsmRegistrationModel.findOne({ _id: id, userId }).lean<IAsmRegistration>();
    if (!r) throw notFound('asm/not-found', 'Registration not found');
    return r;
  },

  list: (userId: string) => AsmRegistrationModel.find({ userId }).sort({ createdAt: -1 }).lean<IAsmRegistration[]>(),

  /** Draft-only mutation with optimistic concurrency. */
  async mutateDraft(userId: string, id: string, mutate: (r: IAsmRegistration) => Record<string, unknown>) {
    const r = await this.get(userId, id);
    if (r.status !== 'draft') throw conflict('asm/not-editable', 'Only draft registrations can be edited.', { current: { status: r.status } } as never);
    const set = mutate(r);
    const updated = await AsmRegistrationModel.findOneAndUpdate({ _id: id, userId, status: 'draft', version: r.version }, { $set: set, $inc: { version: 1 } }, { new: true }).lean<IAsmRegistration>();
    if (!updated) throw conflict('asm/version-conflict', 'The registration changed. Refresh and try again.');
    return updated;
  },

  patchSite(userId: string, id: string, site: { name?: string; country?: string; region?: string; minerals?: string[]; workerCount?: number }) {
    return this.mutateDraft(userId, id, (r) => ({ site: { ...r.site, ...site }, step: r.step === 'site' ? 'gps' : r.step }));
  },

  setGps(userId: string, id: string, gps: { latitude: number; longitude: number; accuracyMetres?: number }) {
    return this.mutateDraft(userId, id, (r) => ({
      gps: { ...gps, capturedAt: now() },
      gpsRegion: gpsRegionLabel(gps.latitude, gps.longitude),
      step: r.step === 'gps' || r.step === 'site' ? 'docs' : r.step,
    }));
  },

  async addDocument(userId: string, id: string, key: AsmDocKey, fileId: string) {
    await uploadsService.owned(userId, fileId);
    return this.mutateDraft(userId, id, (r) => ({
      documents: r.documents.map((d) =>
        d.key === key ? { ...d, fileIds: d.fileIds.includes(fileId) ? d.fileIds : [...d.fileIds, fileId].slice(-10), status: 'uploaded' } : d,
      ),
    }));
  },

  async remove(userId: string, id: string) {
    const r = await this.get(userId, id);
    if (r.status !== 'draft') throw conflict('asm/not-editable', 'Only draft registrations can be deleted.');
    await AsmRegistrationModel.deleteOne({ _id: id, userId, status: 'draft' });
  },

  /** Idempotent: submitting an already-submitted registration returns it unchanged. */
  async submit(userId: string, id: string) {
    const r = await this.get(userId, id);
    if (r.status === 'submitted') return r;
    asmMachine.assert(r.status, 'submitted');
    const missing = missingForSubmit(r);
    if (missing.length) throw unprocessable('Registration is incomplete', { missing }, 'asm/incomplete');
    const updated = await AsmRegistrationModel.findOneAndUpdate(
      { _id: id, userId, status: 'draft', version: r.version },
      { $set: { status: 'submitted', step: 'done', submittedAt: now(), reference: await references.asm(), 'documents.$[].status': 'under_review' }, $inc: { version: 1 } },
      { new: true },
    ).lean<IAsmRegistration>();
    if (!updated) return this.get(userId, id);
    await notifyUser(userId, { event: 'sell.status_changed', title: 'Registration submitted', body: 'Our team will review your registration and schedule a visit.', target: { type: 'asm', id } });
    return updated;
  },

  desk: {
    async transition(id: string, to: AsmStatus, extra: Record<string, unknown> = {}) {
      const r = await AsmRegistrationModel.findById(id).lean<IAsmRegistration>();
      if (!r) throw notFound('asm/not-found', 'Registration not found');
      asmMachine.assert(r.status, to);
      const updated = await AsmRegistrationModel.findOneAndUpdate({ _id: id, status: r.status, version: r.version }, { $set: { status: to, ...extra }, $inc: { version: 1 } }, { new: true }).lean<IAsmRegistration>();
      if (!updated) throw conflict('asm/version-conflict', 'The registration changed concurrently.');
      await notifyUser(r.userId, { event: 'sell.status_changed', title: `Registration ${to.replace(/_/g, ' ')}`, target: { type: 'asm', id } });
      return updated;
    },
  },
};
