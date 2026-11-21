import { z } from 'zod';
import { AppError, conflict, notFound, unprocessable } from '../../../common/errors/app-error.js';
import { nextId } from '../../../common/db/sequence.js';
import { withTx } from '../../../common/db/transaction.js';
import { LetterOfCredit, Contract } from '../../../models/finance.models.js';
import { Order } from '../../../models/trading.models.js';
import { User } from '../../../models/people.models.js';
import { Bank } from '../../reference/reference.model.js';
import { recordAudit } from '../../audit/audit.service.js';
import { assertFourEyes, auditActor } from '../shared/staff-context.js';
import { AMENDMENT_TYPES, LC_STAGES, MS_DAY } from '../shared/enums.js';
import { action, and, boolQ, escapeRegex, intQ, iso, isoDate, oneOf, pageOf, paging, searchFilter, sortSpec } from '../shared/http.js';
import { sendCustomerMessage } from '../shared/messaging.js';
import { adminMoneySchema, addStored, formatMoneyText, outMoney, outMoneyOrZero, parsePositiveMoney, zeroStored } from '../shared/money.js';
import { loadStaffMap, loadUserMap, partyFrom, staffFrom } from '../shared/refs.js';
import { route, type AdminRouteDef } from '../shared/route-kit.js';
import { recordChainEvent } from '../chain/chain.service.js';
import { createSettlement } from '../settlements/settlements.service.js';

const LC_SORT: Record<string, string> = { id: 'lcId', amount: 'amount.amountMinor', status: 'status', expiry: 'expiry', discrepancies: 'openDiscrepancyCount' };

const daysToExpiry = (expiry?: Date | null): number | null => (expiry ? Math.ceil((expiry.getTime() - Date.now()) / MS_DAY) : null);

function lcDto(lc: Record<string, any>, users: Map<string, ReturnType<typeof partyFrom>>) {  
  return {
    id: lc.lcId,
    applicant: partyFrom(users as never, lc.applicantId),
    beneficiary: partyFrom(users as never, lc.beneficiaryId),
    goods: lc.goods ?? '',
    amount: outMoney(lc.amount),
    bank: { id: lc.bankId ?? '', name: lc.bankName ?? '' },
    status: lc.status,
    expiry: lc.expiry ? isoDate(lc.expiry) : null,
    daysToExpiry: daysToExpiry(lc.expiry),
    discrepancyCount: lc.openDiscrepancyCount ?? 0,
    orderId: lc.orderId ?? '',
    contractId: lc.contractId ?? '',
  };
}

async function lcDetail(lc: Record<string, any>) {  
  const [users, staff] = await Promise.all([
    loadUserMap([lc.applicantId, lc.beneficiaryId]),
    loadStaffMap((lc.discrepancies ?? []).map((d: { resolvedBy?: string }) => d.resolvedBy)),
  ]);
  const open = (lc.discrepancies ?? []).filter((d: { status: string }) => d.status === 'open').length;
  let blocked: string | null = null;
  if (lc.status === 'paid') blocked = 'Payment already released';
  else if (lc.status !== 'docs_presented') blocked = 'Release unlocks at Docs presented';
  else if (open > 0) blocked = `${open} open discrepanc${open === 1 ? 'y' : 'ies'} must be resolved first`;
  return {
    ...lcDto(lc, users as never),
    latestShipmentDate: lc.latestShipmentDate ? isoDate(lc.latestShipmentDate) : null,
    documents: (lc.documents ?? []).map((d: { name: string; status: string; fileId?: string }) => ({ name: d.name, status: d.status, ...(d.fileId ? { fileId: d.fileId } : {}) })),
    discrepancies: (lc.discrepancies ?? []).map((d: Record<string, any>) => ({  
      id: d.id,
      text: d.text,
      raisedAt: iso(d.raisedAt),
      status: d.status,
      ...(d.resolvedBy ? { resolvedBy: staffFrom(staff, d.resolvedBy), resolvedAt: iso(d.resolvedAt) } : {}),
    })),
    amendments: (lc.amendments ?? [])
      .filter((a: { draft?: boolean }) => !a.draft)
      .map((a: Record<string, any>) => ({ id: a.id, type: a.type, newValue: a.newValue, status: a.status, requestedAt: iso(a.requestedAt) })),  
    canRelease: blocked === null,
    releaseBlockedReason: blocked,
  };
}

async function requireLc(lcId: string) {
  const lc = await LetterOfCredit.findOne({ lcId }).lean();
  if (!lc) throw notFound('resource/not-found', `Letter of credit ${lcId} not found`);
  return lc;
}

const createBody = z.object({
  contractId: z.string().min(1),
  bankId: z.string().min(1),
  amount: adminMoneySchema,
  latestShipmentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  draft: z.boolean().default(false),
});

export const lcRoutes: AdminRouteDef[] = [
  route(67, 'GET /letters-of-credit/summary', ['financial', 'view'], async (_req, res) => {
    const live = { draft: { $ne: true }, status: { $ne: 'paid' } };
    const now = new Date();
    const in7 = new Date(now.getTime() + 7 * MS_DAY);
    const in48 = new Date(now.getTime() + 2 * MS_DAY);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [open, exp7, exp48, withDisc, paid] = await Promise.all([
      LetterOfCredit.find(live).select('amount').lean(),
      LetterOfCredit.countDocuments({ ...live, expiry: { $gte: now, $lte: in7 } }),
      LetterOfCredit.countDocuments({ ...live, expiry: { $gte: now, $lte: in48 } }),
      LetterOfCredit.find({ ...live, openDiscrepancyCount: { $gt: 0 } }).select('openDiscrepancyCount').lean(),
      LetterOfCredit.find({ status: 'paid', paidAt: { $gte: monthStart } }).select('amount').lean(),
    ]);
    let outstanding = zeroStored();
    for (const l of open) outstanding = addStored(outstanding, l.amount);
    let paidSum = zeroStored();
    for (const l of paid) paidSum = addStored(paidSum, l.amount);
    res.json({
      cards: [
        { key: 'open', label: 'Open LCs', value: open.length, sub: `${formatMoneyText(outMoneyOrZero(outstanding))} outstanding` },
        { key: 'expiring_7d', label: 'Expiring ≤ 7 d', value: exp7, sub: `${exp48} within 48 h` },
        { key: 'with_discrepancies', label: 'With discrepancies', value: withDisc.length, sub: `${withDisc.reduce((n, l) => n + (l.openDiscrepancyCount ?? 0), 0)} open items` },
        { key: 'paid_this_month', label: 'Paid this month', value: outMoneyOrZero(paidSum), sub: `${paid.length} LC${paid.length === 1 ? '' : 's'}` },
      ],
    });
  }),

  route(68, 'GET /letters-of-credit', ['financial', 'view'], async (req, res) => {
    const status = oneOf(req.query.status, LC_STAGES, 'status');
    const within = intQ(req.query.expiringWithinDays, 'expiringWithinDays');
    const hasDisc = boolQ(req.query.hasDiscrepancies);
    let search = searchFilter(req.query.q, ['lcId', 'goods', 'bankName', 'status', 'orderId', 'contractId']);
    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      const re = new RegExp(escapeRegex(req.query.q.trim()), 'i');
      const ids = (await User.find({ $or: [{ name: re }, { org: re }] }).limit(50).lean()).map((u) => u.userId);
      if (ids.length) search = { $or: [...(search as { $or: unknown[] }).$or, { applicantId: { $in: ids } }, { beneficiaryId: { $in: ids } }] };
    }
    const now = new Date();
    const filter = and({ draft: { $ne: true } }, status && { status }, within !== undefined && { status: { $ne: 'paid' }, expiry: { $gte: now, $lte: new Date(now.getTime() + within * MS_DAY) } }, hasDisc !== undefined && { openDiscrepancyCount: hasDisc ? { $gt: 0 } : 0 }, search);
    res.json(
      await pageOf(LetterOfCredit, {
        filter,
        sort: sortSpec(req, LC_SORT, { createdAt: -1, _id: 1 }),
        paging: paging(req),
        map: async (docs: any[]) => {  
          const users = await loadUserMap(docs.flatMap((d) => [d.applicantId, d.beneficiaryId]));
          return docs.map((d) => lcDto(d, users as never));
        },
      }),
    );
  }),

  route(69, 'POST /letters-of-credit', ['financial', 'edit'], async (req, res) => {
    const b = req.body as z.infer<typeof createBody>;
    const actor = auditActor(req);
    const contract = await Contract.findOne({ contractId: b.contractId }).lean();
    if (!contract) throw notFound('resource/not-found', `Contract ${b.contractId} not found`);
    if (contract.status !== 'signed') throw new AppError({ status: 422, code: 'rule/contract-not-signed', message: `${b.contractId} is not signed yet.`, fields: { contractId: 'Contract must be signed' } });
    const bank = await Bank.findOne({ bankId: b.bankId, active: true }).lean();
    if (!bank) throw unprocessable('Unknown bank', { bankId: 'Choose a listed bank' });
    const amount = parsePositiveMoney(b.amount, 'amount');
    if (contract.value && (amount.currency !== contract.value.currency || amount.amountMinor > contract.value.amountMinor)) {
      throw new AppError({ status: 422, code: 'rule/amount-exceeds-contract', message: 'LC amount cannot exceed the contract value.', fields: { amount: `Max ${formatMoneyText(outMoney(contract.value))}` } });
    }
    if (b.expiryDate < b.latestShipmentDate) {
      throw new AppError({ status: 422, code: 'rule/expiry-before-shipment', message: 'LC expiry must be on or after the latest shipment date.', fields: { expiryDate: 'Before latest shipment date' } });
    }
    const out = await withTx(async (session) => {
      const lcId = await nextId('lc', session);
      if (!b.draft) {
        const claimed = await Contract.updateOne({ contractId: b.contractId, $or: [{ lcId: { $exists: false } }, { lcId: null }, { lcId: '' }] }, { $set: { lcId } }, { session });
        if (claimed.modifiedCount === 0) throw conflict('conflict/duplicate', `${b.contractId} already has a letter of credit.`);
      }
      const now = new Date();
      const [created] = await LetterOfCredit.create(
        [
          {
            lcId,
            applicantId: contract.buyerId,
            beneficiaryId: contract.sellerId,
            goods: contract.goods,
            amount,
            bankId: bank.bankId,
            bankName: bank.name,
            status: 'requested',
            expiry: new Date(`${b.expiryDate}T00:00:00Z`),
            latestShipmentDate: new Date(`${b.latestShipmentDate}T00:00:00Z`),
            orderId: contract.orderId,
            contractId: b.contractId,
            documents: ['Commercial invoice', 'Bill of lading', 'Certificate of origin', 'Assay certificate'].map((name) => ({ name, status: 'pending' })),
            stageHistory: [{ stage: 'requested', at: now }],
            draft: b.draft,
            createdBy: actor.staffId,
          },
        ],
        { session },
      );
      if (!b.draft && contract.orderId) await Order.updateOne({ orderId: contract.orderId }, { $set: { linkedLcId: lcId } }, { session });
      if (!b.draft) await recordChainEvent({ type: 'lc_event', ref: { type: 'lc', id: lcId, label: lcId }, description: `LC ${lcId} requested for ${b.contractId}`, payload: { contractId: b.contractId, amount: b.amount }, session });
      const auditId = await recordAudit({ actor, category: 'financial', action: b.draft ? 'Saved LC draft' : 'Requested letter of credit', record: { type: 'lc', id: lcId, label: lcId }, after: { contractId: b.contractId, bank: bank.name, amount: b.amount, expiryDate: b.expiryDate }, req, session, activity: b.draft ? undefined : { text: `LC ${lcId} requested`, meta: `${formatMoneyText(outMoney(amount))} · ${bank.name}`, kind: 'lc' } });
      return { lc: created.toObject(), auditId };
    });
    if (!b.draft) await sendCustomerMessage({ userId: contract.buyerId, subject: `LC request ${out.lc.lcId}`, body: `Please arrange a letter of credit for ${formatMoneyText(outMoney(amount))} with ${bank.name}.`, channels: ['in_app'], related: { type: 'lc', id: out.lc.lcId }, sentBy: actor.staffId }).catch(() => undefined);
    res.status(201).json(action(await lcDetail(out.lc), b.draft ? 'LC draft saved' : 'LC request sent to applicant', out.auditId));
  }, { body: createBody }),

  route(70, 'GET /letters-of-credit/:lcId', ['financial', 'view'], async (req, res) => {
    res.json(await lcDetail(await requireLc(String(req.params.lcId))));
  }),

  route(71, 'POST /letters-of-credit/:lcId/discrepancies/:discrepancyId/resolve', ['financial', 'edit'], async (req, res) => {
    const lcId = String(req.params.lcId);
    const discrepancyId = String(req.params.discrepancyId);
    const b = req.body as { resolution: string; note: string; fileId?: string };
    const lc = await requireLc(lcId);
    const index = (lc.discrepancies ?? []).findIndex((d: { id: string }) => d.id === discrepancyId);
    if (index < 0) throw notFound('resource/not-found', `Discrepancy ${discrepancyId} not found on ${lcId}`);
    if (lc.discrepancies[index].status === 'resolved') throw conflict('conflict/stale-state', `Discrepancy ${index + 1} on ${lcId} is already resolved.`);
    if (lc.status === 'paid') throw conflict('conflict/stale-state', `${lcId} has already been paid.`);
    const actor = auditActor(req);
    const now = new Date();
    const { updated, auditId } = await withTx(async (session) => {
      const updated = await LetterOfCredit.findOneAndUpdate(
        { lcId, discrepancies: { $elemMatch: { id: discrepancyId, status: 'open' } } },
        { $set: { 'discrepancies.$.status': 'resolved', 'discrepancies.$.resolvedBy': actor.staffId, 'discrepancies.$.resolvedAt': now, 'discrepancies.$.resolution': b.resolution, 'discrepancies.$.note': b.note, ...(b.fileId ? { 'discrepancies.$.fileId': b.fileId } : {}) }, $inc: { openDiscrepancyCount: -1 } },
        { new: true, session },
      ).lean();
      if (!updated) throw conflict('conflict/stale-state', `Discrepancy ${index + 1} on ${lcId} was just resolved by someone else.`);
      if ((updated.openDiscrepancyCount ?? 0) <= 0) {
        await LetterOfCredit.updateOne({ lcId }, { $set: { 'documents.$[d].status': 'received' } }, { arrayFilters: [{ 'd.status': 'discrepant' }], session });
      }
      const auditId = await recordAudit({ actor, category: 'financial', action: 'Resolved LC discrepancy', record: { type: 'lc', id: lcId, label: lcId }, before: { discrepancy: lc.discrepancies[index].text, status: 'open' }, after: { status: 'resolved', resolution: b.resolution }, reason: b.note, req, session });
      return { updated: (await LetterOfCredit.findOne({ lcId }, null, { session }).lean())!, auditId };
    });
    res.json(action(await lcDetail(updated), `Discrepancy ${index + 1} on ${lcId} marked resolved`, auditId));
  }, { body: z.object({ resolution: z.enum(['waived_by_applicant', 'corrected_document', 'bank_accepted']), note: z.string().trim().min(3).max(1000), fileId: z.string().optional() }) }),

  // #72 — money-moving: Idempotency-Key required + four-eyes (requester cannot release).
  route(72, 'POST /letters-of-credit/:lcId/release', ['financial', 'edit'], async (req, res) => {
    const lcId = String(req.params.lcId);
    const { expectedAmount } = req.body as { expectedAmount: { amount: number; currency: string } };
    const lc = await requireLc(lcId);
    assertFourEyes(req, [lc.createdBy]);
    if (lc.status === 'paid') throw conflict('conflict/stale-state', `${lcId} has already been paid.`, { details: { status: 'paid' } });
    if (lc.status !== 'docs_presented') throw new AppError({ status: 422, code: 'rule/lc-not-presented', message: 'Release unlocks at Docs presented.' });
    if ((lc.openDiscrepancyCount ?? 0) > 0) throw new AppError({ status: 422, code: 'rule/lc-open-discrepancies', message: `Resolve ${lc.openDiscrepancyCount} open discrepanc${lc.openDiscrepancyCount === 1 ? 'y' : 'ies'} before releasing payment.` });
    const expected = parsePositiveMoney(expectedAmount, 'expectedAmount');
    if (expected.currency !== lc.amount.currency || expected.amountMinor !== lc.amount.amountMinor) {
      throw new AppError({ status: 422, code: 'rule/amount-mismatch', message: `The LC amount is ${formatMoneyText(outMoney(lc.amount))}, not ${formatMoneyText(outMoney(expected))}.`, details: { actual: outMoney(lc.amount) } });
    }
    const actor = auditActor(req);
    const now = new Date();
    const { updated, settlementId, auditId } = await withTx(async (session) => {
      const updated = await LetterOfCredit.findOneAndUpdate(
        { lcId, status: 'docs_presented', openDiscrepancyCount: { $lte: 0 } },
        { $set: { status: 'paid', paidAt: now }, $push: { stageHistory: { stage: 'paid', at: now } } },
        { new: true, session },
      ).lean();
      if (!updated) throw conflict('conflict/stale-state', `${lcId} changed state — refresh and try again.`);
      const settlementId = await createSettlement({ kind: 'seller_payout', ref: { type: 'lc', id: lcId }, partyId: lc.beneficiaryId, amount: lc.amount, status: 'released', rail: 'bank', createdBy: actor.staffId, date: now, session });
      await LetterOfCredit.updateOne({ lcId }, { $set: { settlementId: settlementId } }, { session });
      if (lc.orderId) await Order.updateOne({ orderId: lc.orderId }, { $set: { paymentStatus: 'released', releasedAmount: lc.amount }, $push: { history: { text: `Payment released under ${lcId}`, actorId: actor.staffId, at: now } } }, { session });
      await recordChainEvent({ type: 'lc_event', ref: { type: 'lc', id: lcId, label: lcId }, description: `LC ${lcId} paid`, payload: { settlementId: settlementId }, session });
      const auditId = await recordAudit({ actor, category: 'financial', action: 'Released LC payment', record: { type: 'lc', id: lcId, label: lcId }, before: { status: 'docs_presented' }, after: { status: 'paid', amount: outMoney(lc.amount), settlementId: settlementId }, req, session, activity: { text: `Payment released under ${lcId}`, meta: formatMoneyText(outMoney(lc.amount)), kind: 'lc' } });
      return { updated: { ...updated, settlementId: settlementId }, settlementId: settlementId, auditId };
    });
    res.json(action({ ...(await lcDetail(updated)), settlementId }, `Payment of ${formatMoneyText(outMoney(lc.amount))} released under ${lcId}`, auditId));
  }, { idem: 'required', body: z.object({ expectedAmount: adminMoneySchema }) }),

  route(73, 'POST /letters-of-credit/:lcId/amendments', ['financial', 'edit'], async (req, res) => {
    const lcId = String(req.params.lcId);
    const b = req.body as { type: (typeof AMENDMENT_TYPES)[number]; newValue: string; reason: string; draft: boolean };
    const lc = await requireLc(lcId);
    if (lc.status === 'paid') throw conflict('conflict/stale-state', `${lcId} has already been paid.`);
    const actor = auditActor(req);
    const now = new Date();
    const { amendmentId, auditId } = await withTx(async (session) => {
      const amendmentId = await nextId('amendment', session);
      await LetterOfCredit.updateOne({ lcId }, { $push: { amendments: { id: amendmentId, type: b.type, newValue: b.newValue, reason: b.reason, status: 'requested', requestedAt: now, requestedBy: actor.staffId, draft: b.draft } } }, { session });
      const auditId = await recordAudit({ actor, category: 'financial', action: b.draft ? 'Saved LC amendment draft' : 'Requested LC amendment', record: { type: 'lc', id: lcId, label: lcId }, after: { amendmentId, type: b.type, newValue: b.newValue }, reason: b.reason, req, session });
      return { amendmentId, auditId };
    });
    res.status(201).json(action({ amendmentId }, b.draft ? `Amendment draft saved on ${lcId}` : `Amendment requested on ${lcId}`, auditId));
  }, { body: z.object({ type: z.enum(AMENDMENT_TYPES), newValue: z.string().trim().min(1).max(200), reason: z.string().trim().min(3).max(1000), draft: z.boolean().default(false) }) }),
];

export { lcDto, lcDetail };
