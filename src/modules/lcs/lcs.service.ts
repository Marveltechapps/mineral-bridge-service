import { createHash } from 'node:crypto';
import { conflict, forbidden, notFound, unprocessable } from '../../common/errors/app-error.js';
import { addMs, DAY_MS, now } from '../../common/utils/clock.js';
import { opaqueId } from '../../common/utils/ids.js';
import { references } from '../../common/utils/references.js';
import { StateMachine } from '../../common/utils/state-machine.js';
import { BankOperatorModel, ContractModel, LetterOfCreditModel } from '../../models/contract-lc.model.js';
import type { IBankOperator, IContract, IDiscrepancy, ILetterOfCredit, LcDocKey, LcStatus } from '../../models/contract-lc.model.js';
import { NegotiationModel } from '../../models/web-trade.model.js';
import { contentService } from '../content/content.service.js';
import { notifyUser } from '../notifications/notifications.service.js';
import { walletService } from '../payouts/payouts.service.js';
import { uploadsService } from '../uploads/uploads.service.js';

export const lcMachine = new StateMachine<LcStatus>(
  'lc',
  {
    Applied: ['Issued', 'Refused', 'Expired'],
    Issued: ['Advised', 'Expired'],
    Advised: ['Confirmed', 'Presented', 'Expired'],
    Confirmed: ['Presented', 'Expired'],
    Presented: ['Examined', 'Refused'],
    Examined: ['Paid', 'Refused'],
    Paid: [],
    Refused: [],
    Expired: [],
  },
  'lc/invalid-transition',
);

export const LC_VALIDITY_DAYS = 120;
export const SHIPMENT_WINDOW_DAYS = 60;
const PRESENTABLE: LcStatus[] = ['Advised', 'Confirmed'];
const DOCUMENT_UPLOADABLE: LcStatus[] = ['Issued', 'Advised', 'Confirmed'];

export const requiredDocuments = (lc: Pick<ILetterOfCredit, 'incoterm'>): LcDocKey[] => {
  const base: LcDocKey[] = ['invoice', 'bl', 'packing', 'origin', 'assay'];
  return ['CIF', 'CIP'].includes(lc.incoterm.toUpperCase()) ? [...base, 'insurance'] : base;
};

const norm = (s: string | undefined) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

export const docsFingerprint = (docs: ILetterOfCredit['documents']) =>
  createHash('sha256').update(docs.map((d) => `${d.key}:${d.fileId}`).sort().join('|')).digest('hex').slice(0, 32);

/**
 * Pure document check against the LC terms. Extracted fields come from the uploader/OCR stage; the
 * bank's examination is the authority, this only warns the beneficiary before presentation.
 */
export function precheckDocuments(lc: ILetterOfCredit, at: Date = now()): { compliant: boolean; discrepancies: IDiscrepancy[] } {
  const d: IDiscrepancy[] = [];
  const by = new Map(lc.documents.map((x) => [x.key, x]));
  for (const key of requiredDocuments(lc)) {
    if (!by.has(key)) d.push({ code: 'DOC_MISSING', documentKey: key, message: `Required document missing: ${key}`, severity: 'discrepancy' });
  }
  if (lc.expiresAt.getTime() < at.getTime()) d.push({ code: 'LC_EXPIRED', documentKey: null, message: 'The letter of credit has expired', severity: 'discrepancy' });
  const bl = by.get('bl');
  const onBoard = bl?.extracted?.onBoardDate;
  if (onBoard) {
    if (onBoard > lc.latestShipmentDate) d.push({ code: 'LATE_SHIPMENT', documentKey: 'bl', message: `On-board date ${onBoard} is after the latest shipment date ${lc.latestShipmentDate}`, severity: 'discrepancy' });
    const deadline = new Date(Date.parse(onBoard) + lc.presentationPeriodDays * DAY_MS);
    if (!Number.isNaN(deadline.getTime()) && deadline.getTime() < at.getTime()) d.push({ code: 'LATE_PRESENTATION', documentKey: 'bl', message: `Presentation period of ${lc.presentationPeriodDays} days has elapsed`, severity: 'discrepancy' });
  } else if (bl) {
    d.push({ code: 'BL_DATE_UNREADABLE', documentKey: 'bl', message: 'On-board date could not be read from the bill of lading', severity: 'warning' });
  }
  const inv = by.get('invoice');
  if (inv?.extracted?.amountMinor !== undefined) {
    const amt = Number(inv.extracted.amountMinor);
    if (!Number.isFinite(amt)) d.push({ code: 'INVOICE_AMOUNT_UNREADABLE', documentKey: 'invoice', message: 'Invoice amount is not a number', severity: 'warning' });
    else if (amt > lc.amount.amountMinor) d.push({ code: 'AMOUNT_EXCEEDS', documentKey: 'invoice', message: 'Invoice amount exceeds the LC amount', severity: 'discrepancy' });
  }
  if (inv?.extracted?.goods && norm(inv.extracted.goods) !== norm(lc.goodsDescription)) {
    d.push({ code: 'DESCRIPTION_MISMATCH', documentKey: 'invoice', message: 'Goods description differs from the LC', severity: 'discrepancy' });
  }
  return { compliant: !d.some((x) => x.severity === 'discrepancy'), discrepancies: d };
}

const partyRole = (lc: Pick<ILetterOfCredit, 'applicantId' | 'beneficiaryId'>, userId: string) =>
  lc.applicantId === userId ? 'applicant' : lc.beneficiaryId === userId ? 'beneficiary' : null;

async function bankInfo(id: string) {
  const b = (await contentService.reference('bank')).find((x) => x.code === id);
  return { id, name: b?.name ?? id, swift: String((b?.data as { swift?: string } | undefined)?.swift ?? '') };
}

async function cas(lc: ILetterOfCredit, to: LcStatus, set: Record<string, unknown>, milestone: string): Promise<ILetterOfCredit> {
  lcMachine.assert(lc.status, to);
  const updated = await LetterOfCreditModel.findOneAndUpdate(
    { _id: lc._id, version: lc.version, status: lc.status },
    { $set: { status: to, ...set }, $push: { milestones: { key: milestone, at: now() } }, $inc: { version: 1 } },
    { new: true },
  ).lean<ILetterOfCredit>();
  if (!updated) {
    const cur = await LetterOfCreditModel.findById(lc._id).lean<ILetterOfCredit>();
    throw conflict('lc/state-changed', 'The letter of credit changed. Refresh and try again.', { current: { status: cur?.status } } as never);
  }
  for (const uid of [updated.applicantId, updated.beneficiaryId]) {
    await notifyUser(uid, { event: 'lc.status_changed', title: `LC ${updated.reference}: ${to}`, target: { type: 'lc', id: updated._id } });
  }
  return updated;
}

export const lcsService = {
  /** Buyer applies against a fully signed contract. One LC per contract (unique index) => idempotent. */
  async create(userId: string, contractId: string): Promise<ILetterOfCredit> {
    const c = await ContractModel.findById(contractId).lean<IContract>();
    if (!c || c.buyerId !== userId) throw notFound('contract/not-found', 'Contract not found');
    if (c.status !== 'countersigned') throw conflict('lc/contract-not-executed', 'The contract must be signed by both parties before applying for an LC.');
    const existing = await LetterOfCreditModel.findOne({ contractId }).lean<ILetterOfCredit>();
    if (existing) return existing;
    const bank = await bankInfo(c.terms.issuingBankId);
    const at = now();
    try {
      const doc = await LetterOfCreditModel.create({
        reference: await references.lc(),
        status: 'Applied',
        lcType: c.terms.lcType,
        tenor: c.terms.tenor,
        amount: c.terms.total,
        contractId,
        applicantId: c.buyerId,
        beneficiaryId: c.sellerId,
        issuingBank: bank,
        goodsDescription: c.terms.lotDescription,
        incoterm: c.terms.incoterm,
        namedPort: c.terms.namedPort,
        latestShipmentDate: addMs(at, SHIPMENT_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10),
        expiresAt: addMs(at, LC_VALIDITY_DAYS * DAY_MS),
        presentationPeriodDays: c.terms.presentationPeriodDays,
        documents: [],
        milestones: [{ key: 'applied', at }],
        amendments: [],
        version: 0,
      });
      const lc = doc.toObject() as ILetterOfCredit;
      await ContractModel.updateOne({ _id: contractId }, { $set: { lcId: lc._id } });
      await NegotiationModel.updateOne({ _id: c.negotiationId }, { $set: { lcId: lc._id } });
      return lc;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        const again = await LetterOfCreditModel.findOne({ contractId }).lean<ILetterOfCredit>();
        if (again) return again;
      }
      throw err;
    }
  },

  /** Lazy expiry for LCs that were never presented. */
  async expireIfDue(lc: ILetterOfCredit): Promise<ILetterOfCredit> {
    if (lc.expiresAt.getTime() > now().getTime() || !lcMachine.can(lc.status, 'Expired')) return lc;
    try {
      return await cas(lc, 'Expired', {}, 'expired');
    } catch {
      return (await LetterOfCreditModel.findById(lc._id).lean<ILetterOfCredit>()) ?? lc;
    }
  },

  async get(userId: string, id: string): Promise<ILetterOfCredit> {
    const lc = await LetterOfCreditModel.findById(id).lean<ILetterOfCredit>();
    if (!lc || !partyRole(lc, userId)) throw notFound('lc/not-found', 'Letter of credit not found');
    return this.expireIfDue(lc);
  },

  async list(userId: string, status: LcStatus | undefined, skip: number, limit: number) {
    const filter = { $or: [{ applicantId: userId }, { beneficiaryId: userId }], ...(status ? { status } : {}) };
    const [rows, total] = await Promise.all([
      LetterOfCreditModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean<ILetterOfCredit[]>(),
      LetterOfCreditModel.countDocuments(filter),
    ]);
    return { rows, total };
  },

  async addDocument(userId: string, id: string, input: { key: LcDocKey; fileId: string; extracted?: Record<string, string> }) {
    const lc = await this.get(userId, id);
    if (partyRole(lc, userId) !== 'beneficiary') throw forbidden('lc/beneficiary-only', 'Only the beneficiary can upload presentation documents.');
    if (!DOCUMENT_UPLOADABLE.includes(lc.status)) throw conflict('lc/documents-closed', `Documents cannot be uploaded while the LC is ${lc.status}.`);
    await uploadsService.owned(userId, input.fileId);
    const documents = lc.documents.filter((d) => d.key !== input.key).concat({ key: input.key, fileId: input.fileId, uploadedAt: now(), extracted: input.extracted });
    // Any document change invalidates the previous precheck.
    const updated = await LetterOfCreditModel.findOneAndUpdate({ _id: id, version: lc.version, status: lc.status }, { $set: { documents }, $unset: { precheck: 1 }, $inc: { version: 1 } }, { new: true }).lean<ILetterOfCredit>();
    if (!updated) throw conflict('lc/state-changed', 'The letter of credit changed. Refresh and try again.');
    return updated;
  },

  async removeDocument(userId: string, id: string, documentKey: string) {
    const lc = await this.get(userId, id);
    if (partyRole(lc, userId) !== 'beneficiary') throw forbidden('lc/beneficiary-only', 'Only the beneficiary can remove presentation documents.');
    if (!DOCUMENT_UPLOADABLE.includes(lc.status)) throw conflict('lc/documents-closed', `Documents cannot be removed while the LC is ${lc.status}.`);
    if (!lc.documents.some((d) => d.key === documentKey)) throw notFound('lc/document-not-found', 'Document not found on this LC');
    const documents = lc.documents.filter((d) => d.key !== documentKey);
    const updated = await LetterOfCreditModel.findOneAndUpdate({ _id: id, version: lc.version, status: lc.status }, { $set: { documents }, $unset: { precheck: 1 }, $inc: { version: 1 } }, { new: true }).lean<ILetterOfCredit>();
    if (!updated) throw conflict('lc/state-changed', 'The letter of credit changed. Refresh and try again.');
    return updated;
  },

  async requestAmendment(userId: string, id: string, input: { fields: Record<string, unknown>; reason?: string }) {
    const lc = await this.get(userId, id);
    if (partyRole(lc, userId) !== 'applicant') throw forbidden('lc/applicant-only', 'Only the applicant can request an amendment.');
    if (['Paid', 'Expired', 'Refused'].includes(lc.status)) throw conflict('lc/invalid-transition', `Amendments are not allowed while the LC is ${lc.status}.`);
    const changes = Object.entries(input.fields).map(([field, to]) => ({
      field,
      from: String((lc as unknown as Record<string, unknown>)[field] ?? ''),
      to: String(to ?? ''),
    }));
    const amendment = {
      _id: opaqueId('amd'),
      status: 'requested',
      changes,
      reason: input.reason ?? '',
      requestedAt: now(),
      approvals: [
        { party: 'applicant', approved: true },
        { party: 'beneficiary', approved: null },
        { party: 'issuing_bank', approved: null },
      ],
    };
    const updated = await LetterOfCreditModel.findOneAndUpdate(
      { _id: id, version: lc.version },
      { $push: { amendments: amendment }, $inc: { version: 1 } },
      { new: true },
    ).lean<ILetterOfCredit>();
    if (!updated) throw conflict('lc/state-changed', 'The letter of credit changed. Refresh and try again.');
    return updated;
  },

  async precheck(userId: string, id: string) {
    const lc = await this.get(userId, id);
    if (partyRole(lc, userId) !== 'beneficiary') throw forbidden('lc/beneficiary-only', 'Only the beneficiary can run a precheck.');
    const result = precheckDocuments(lc);
    const precheck = { checkedAt: now(), compliant: result.compliant, discrepancies: result.discrepancies, docsFingerprint: docsFingerprint(lc.documents) };
    const updated = await LetterOfCreditModel.findOneAndUpdate({ _id: id, version: lc.version }, { $set: { precheck }, $inc: { version: 1 } }, { new: true }).lean<ILetterOfCredit>();
    return updated ?? this.get(userId, id);
  },

  /** Idempotent: presenting an already-presented LC returns it unchanged. */
  async present(userId: string, id: string, input: { notes?: string; acknowledgeDiscrepancies?: boolean }) {
    const lc = await this.get(userId, id);
    if (partyRole(lc, userId) !== 'beneficiary') throw forbidden('lc/beneficiary-only', 'Only the beneficiary can present documents.');
    if (lc.status === 'Presented') return lc;
    if (!PRESENTABLE.includes(lc.status)) throw conflict('lc/invalid-transition', `Documents cannot be presented while the LC is ${lc.status}.`, { current: { state: lc.status } } as never);
    const pre = lc.precheck;
    if (!pre || pre.docsFingerprint !== docsFingerprint(lc.documents)) throw conflict('lc/precheck-required', 'Run a precheck on the current documents before presenting.');
    const blocking = pre.discrepancies.filter((x) => x.severity === 'discrepancy');
    const missing = blocking.filter((x) => x.code === 'DOC_MISSING' || x.code === 'LC_EXPIRED');
    if (missing.length) throw unprocessable('Presentation is incomplete', { discrepancies: missing.map((x) => x.message) }, 'lc/incomplete-presentation');
    if (blocking.length && !input.acknowledgeDiscrepancies) throw conflict('lc/discrepancies-unacknowledged', 'The precheck found discrepancies. Acknowledge them to present anyway.', { current: { discrepancies: blocking } } as never);
    return cas(lc, 'Presented', { presentation: { presentedAt: now(), notes: input.notes, discrepancies: pre.discrepancies } }, 'presented');
  },

  /* ───────────── bank portal ───────────── */

  bank: {
    async banksFor(userId: string): Promise<string[]> {
      const op = await BankOperatorModel.findOne({ userId }).lean<IBankOperator>();
      if (!op || op.bankIds.length === 0) throw forbidden('lc/bank-not-assigned', 'Your account is not assigned to a bank.');
      return op.bankIds;
    },

    async grant(userId: string, bankIds: string[]) {
      await BankOperatorModel.updateOne({ userId }, { $set: { bankIds } }, { upsert: true });
    },

    async list(userId: string, status: LcStatus | undefined, skip: number, limit: number) {
      const banks = await this.banksFor(userId);
      const filter = { 'issuingBank.id': { $in: banks }, ...(status ? { status } : {}) };
      const [rows, total] = await Promise.all([
        LetterOfCreditModel.find(filter).sort({ updatedAt: -1, _id: -1 }).skip(skip).limit(limit).lean<ILetterOfCredit[]>(),
        LetterOfCreditModel.countDocuments(filter),
      ]);
      return { rows, total };
    },

    async get(userId: string, id: string): Promise<ILetterOfCredit> {
      const banks = await this.banksFor(userId);
      const lc = await LetterOfCreditModel.findById(id).lean<ILetterOfCredit>();
      if (!lc || !banks.includes(lc.issuingBank.id)) throw notFound('lc/not-found', 'Letter of credit not found');
      return lc;
    },

    async issue(userId: string, id: string) {
      return cas(await this.get(userId, id), 'Issued', {}, 'issued');
    },

    async amend(userId: string, id: string, input: { fields: Record<string, unknown>; reason?: string }) {
      const lc = await this.get(userId, id);
      if (['Paid', 'Expired'].includes(lc.status)) throw conflict('lc/invalid-transition', `Amendments are not allowed while the LC is ${lc.status}.`);
      const changes = Object.entries(input.fields).map(([field, to]) => ({
        field,
        from: String((lc as unknown as Record<string, unknown>)[field] ?? ''),
        to: String(to ?? ''),
      }));
      const amendment = {
        _id: opaqueId('amd'),
        status: 'bank_draft',
        changes,
        reason: input.reason ?? '',
        requestedAt: now(),
        approvals: [
          { party: 'issuing_bank', approved: true },
          { party: 'applicant', approved: null },
          { party: 'beneficiary', approved: null },
        ],
      };
      const updated = await LetterOfCreditModel.findOneAndUpdate(
        { _id: id, version: lc.version },
        { $push: { amendments: amendment }, $inc: { version: 1 } },
        { new: true },
      ).lean<ILetterOfCredit>();
      if (!updated) throw conflict('lc/state-changed', 'The letter of credit changed. Refresh and try again.');
      return updated;
    },

    async advise(userId: string, id: string, advisingBankId?: string) {
      const lc = await this.get(userId, id);
      const advisingBank = advisingBankId ? await bankInfo(advisingBankId) : lc.issuingBank;
      return cas(lc, 'Advised', { advisingBank }, 'advised');
    },

    async confirm(userId: string, id: string) {
      const lc = await this.get(userId, id);
      if (lc.lcType !== 'Confirmed') throw conflict('lc/not-confirmable', 'Only a Confirmed LC can be confirmed by the advising bank.');
      return cas(lc, 'Confirmed', {}, 'confirmed');
    },

    async examine(userId: string, id: string, input: { decision: 'accepted' | 'refused'; discrepancies?: IDiscrepancy[]; notes?: string }) {
      const lc = await this.get(userId, id);
      if (!lc.presentation) throw conflict('lc/not-presented', 'No presentation to examine.');
      if (input.decision === 'refused' && !(input.discrepancies?.length || input.notes)) throw unprocessable('A refusal must state its reasons', { discrepancies: 'Required' }, 'lc/refusal-reasons-required');
      const presentation = { ...lc.presentation, examination: input.decision, examinedAt: now(), discrepancies: input.discrepancies ?? lc.presentation.discrepancies, examinerNotes: input.notes };
      return cas(lc, input.decision === 'accepted' ? 'Examined' : 'Refused', { presentation }, input.decision === 'accepted' ? 'examined' : 'refused');
    },

    /** Exactly-once payment: wallet credit is keyed by the LC; the status CAS decides the single winner. */
    async pay(userId: string, id: string, reference?: string) {
      const lc = await this.get(userId, id);
      if (lc.status === 'Paid') return lc;
      lcMachine.assert(lc.status, 'Paid');
      await walletService.credit(lc.beneficiaryId, lc.amount.amountMinor, lc.amount.currency, 'sale_proceeds', { type: 'lc', id: lc._id }, `LC ${lc.reference}`);
      try {
        return await cas(lc, 'Paid', { payment: { releasedAt: now(), amount: lc.amount, reference, anchor: { hash: docsFingerprint(lc.documents), network: 'mb-ledger', blockNumber: null, anchoredAt: null } } }, 'paid');
      } catch (err) {
        const cur = await LetterOfCreditModel.findById(id).lean<ILetterOfCredit>();
        if (cur?.status === 'Paid') return cur; // lost the race to an identical request
        throw err;
      }
    },
  },
};
