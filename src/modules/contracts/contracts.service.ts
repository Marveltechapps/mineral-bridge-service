import { createHash } from 'node:crypto';
import { conflict, forbidden, notFound, unprocessable } from '../../common/errors/app-error.js';
import { now } from '../../common/utils/clock.js';
import { references } from '../../common/utils/references.js';
import { StateMachine } from '../../common/utils/state-machine.js';
import { createSignedUrl } from '../../common/storage/signed-url.js';
import { ContractModel } from '../../models/contract-lc.model.js';
import type { ContractStatus, IContract, LcType, Tenor } from '../../models/contract-lc.model.js';
import { NegotiationModel } from '../../models/web-trade.model.js';
import type { INegotiation } from '../../models/web-trade.model.js';
import { contentService } from '../content/content.service.js';
import { notifyUser } from '../notifications/notifications.service.js';
import { PLATFORM_SELLER_ID } from '../negotiations/negotiations.service.js';

export const contractMachine = new StateMachine<ContractStatus>(
  'contract',
  { draft: ['signed', 'cancelled'], signed: ['countersigned', 'cancelled'], countersigned: [], cancelled: [] },
  'contract/invalid-transition',
);

export type ContractTermsInput = { lcType: LcType; tenor: Tenor; issuingBankId: string; presentationPeriodDays: number };

const roleOf = (c: Pick<IContract, 'buyerId' | 'sellerId'>, userId: string): 'buyer' | 'seller' | null =>
  c.buyerId === userId ? 'buyer' : c.sellerId === userId ? 'seller' : null;

/** Deterministic hash of the commercial terms (stable key order). */
export function hashTerms(terms: IContract['terms']): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)])) : v;
  return createHash('sha256').update(JSON.stringify(canon(terms))).digest('hex');
}

async function bank(id: string) {
  const b = (await contentService.reference('bank')).find((x) => x.code === id);
  if (!b) throw unprocessable('Unknown issuing bank', { issuingBankId: 'Unknown bank' }, 'contract/unknown-bank');
  return { id: b.code, name: b.name };
}

export const contractsService = {
  async create(userId: string, negotiationId: string, input: ContractTermsInput): Promise<IContract> {
    const n = await NegotiationModel.findById(negotiationId).lean<INegotiation>();
    if (!n || (n.buyerId !== userId && n.sellerId !== userId)) throw notFound('negotiation/not-found', 'Negotiation not found');
    if (n.status !== 'agreed' || !n.agreedOfferId) throw conflict('contract/negotiation-not-agreed', 'A contract can only be drafted from an agreed negotiation.');
    const offer = n.offers.find((o) => o._id === n.agreedOfferId);
    if (!offer) throw conflict('contract/negotiation-not-agreed', 'Agreed offer not found.');
    const existing = await ContractModel.findOne({ negotiationId, status: { $ne: 'cancelled' } }).lean<IContract>();
    if (existing) return existing; // natural-key idempotency: one live contract per negotiation
    const b = await bank(input.issuingBankId);
    try {
      const doc = await ContractModel.create({
        reference: await references.contract(),
        status: 'draft',
        negotiationId,
        acceptedOfferId: offer._id,
        buyerId: n.buyerId,
        sellerId: n.sellerId,
        signatories: {},
        liveKey: negotiationId,
        terms: {
          lotDescription: `${n.lotName}${n.lotGrade ? ` (${n.lotGrade})` : ''}`,
          incoterm: offer.incoterm,
          namedPort: offer.namedPort,
          unitPrice: offer.price,
          quantity: offer.quantity,
          unit: offer.unit,
          total: offer.total,
          shipmentFrom: offer.shipmentFrom,
          shipmentTo: offer.shipmentTo,
          lcType: input.lcType,
          tenor: input.tenor,
          issuingBankId: b.id,
          issuingBankName: b.name,
          presentationPeriodDays: input.presentationPeriodDays,
        },
        signatures: {},
        version: 0,
      });
      const c = doc.toObject() as IContract;
      await NegotiationModel.updateOne({ _id: negotiationId }, { $set: { contractId: c._id } });
      return c;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        const again = await ContractModel.findOne({ negotiationId, status: { $ne: 'cancelled' } }).lean<IContract>();
        if (again) return again;
      }
      throw err;
    }
  },

  async get(userId: string, id: string): Promise<IContract> {
    const c = await ContractModel.findById(id).lean<IContract>();
    if (!c || !roleOf(c, userId)) throw notFound('contract/not-found', 'Contract not found');
    return c;
  },

  async list(userId: string, status: ContractStatus | undefined, skip: number, limit: number) {
    const filter = { $or: [{ buyerId: userId }, { sellerId: userId }], ...(status ? { status } : {}) };
    const [rows, total] = await Promise.all([
      ContractModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean<IContract[]>(),
      ContractModel.countDocuments(filter),
    ]);
    return { rows, total };
  },

  /** Terms are editable only before anyone has signed. */
  async patch(userId: string, id: string, patch: Partial<ContractTermsInput>) {
    const c = await this.get(userId, id);
    if (c.status !== 'draft') throw conflict('contract/terms-locked', 'Terms cannot be changed once a party has signed.');
    const terms = { ...c.terms, ...(patch.lcType ? { lcType: patch.lcType } : {}), ...(patch.tenor ? { tenor: patch.tenor } : {}), ...(patch.presentationPeriodDays ? { presentationPeriodDays: patch.presentationPeriodDays } : {}) };
    if (patch.issuingBankId) {
      const b = await bank(patch.issuingBankId);
      terms.issuingBankId = b.id;
      terms.issuingBankName = b.name;
    }
    const updated = await ContractModel.findOneAndUpdate({ _id: id, status: 'draft', version: c.version }, { $set: { terms }, $inc: { version: 1 } }, { new: true }).lean<IContract>();
    if (!updated) throw conflict('contract/terms-locked', 'The contract changed. Refresh and try again.');
    return updated;
  },

  async sign(userId: string, id: string, signatory: string) {
    const c = await this.get(userId, id);
    const role = roleOf(c, userId)!;
    if (c.status === 'cancelled') throw conflict('contract/cancelled', 'This contract was cancelled.');
    if (c.signatures[role]) throw conflict('contract/already-signed', 'You have already signed this contract.');
    if (c.status === 'countersigned') throw conflict('contract/already-signed', 'This contract is fully signed.');
    const to: ContractStatus = c.status === 'draft' ? 'signed' : 'countersigned';
    contractMachine.assert(c.status, to);
    const signedAt = now();
    const termsHash = c.termsHash ?? hashTerms(c.terms);
    const set: Record<string, unknown> = { status: to, termsHash, [`signatures.${role}`]: { signatory, signedAt }, [`signatories.${role}`]: signatory };
    if (to === 'countersigned') {
      // Ledger anchoring is a stub: the hash is recorded; block data is filled by the anchoring job.
      set.anchor = { hash: termsHash, network: 'mb-ledger', blockNumber: null, anchoredAt: null };
    }
    const updated = await ContractModel.findOneAndUpdate(
      { _id: id, version: c.version, status: c.status, [`signatures.${role}`]: { $exists: false } },
      { $set: set, $inc: { version: 1 } },
      { new: true },
    ).lean<IContract>();
    if (!updated) {
      const cur = await ContractModel.findById(id).lean<IContract>();
      if (cur?.signatures[role]) throw conflict('contract/already-signed', 'You have already signed this contract.');
      throw conflict('contract/state-changed', 'The contract changed. Refresh and try again.');
    }
    const other = role === 'buyer' ? c.sellerId : c.buyerId;
    if (other !== PLATFORM_SELLER_ID) await notifyUser(other, { event: 'contract.signed', title: `Contract ${c.reference} ${to === 'signed' ? 'signed by counterparty' : 'fully executed'}`, target: { type: 'contract', id } });
    return updated;
  },

  async cancel(userId: string, id: string) {
    const c = await this.get(userId, id);
    contractMachine.assert(c.status, 'cancelled', 'A fully signed contract cannot be cancelled here.');
    if (c.lcId) throw conflict('contract/has-lc', 'A letter of credit exists for this contract.');
    const updated = await ContractModel.findOneAndUpdate({ _id: id, version: c.version, status: c.status }, { $set: { status: 'cancelled' }, $unset: { liveKey: 1 }, $inc: { version: 1 } }, { new: true }).lean<IContract>();
    if (!updated) throw conflict('contract/state-changed', 'The contract changed. Refresh and try again.');
    await NegotiationModel.updateOne({ _id: c.negotiationId, contractId: id }, { $unset: { contractId: 1 } });
    return updated;
  },

  /** The PDF is a generated artefact: return a short-lived signed URL (rendering is a stub). */
  async document(userId: string, id: string) {
    const c = await this.get(userId, id);
    if (c.status === 'cancelled') throw forbidden('contract/cancelled', 'This contract was cancelled.');
    return createSignedUrl('contract', c._id, 300);
  },
};
