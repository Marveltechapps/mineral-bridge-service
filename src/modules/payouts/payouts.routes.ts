import { Router } from 'express';
import { currentUserId } from '../../common/http/actor.js';
import { ah } from '../../common/http/async-handler.js';
import { idempotencyKey, requireKeyOrThrow } from '../../common/middleware/idempotency-key.js';
import { validate } from '../../common/middleware/validate.js';
import { buildCursorPage, cursorWindow } from '../../common/utils/cursor.js';
import { mobileMoney, parseCustomerMoney } from '../../common/utils/currency.js';
import { iso } from '../../common/utils/time-display.js';
import type { ILedgerEntry, IPayoutAccount, IWithdrawal } from '../../models/payout.model.js';
import { requireKyc, requireTransactionPin, requireUser } from '../auth/auth.middleware.js';
import { payoutsService as svc, walletService } from './payouts.service.js';
import * as v from './payouts.validation.js';

export const toMobileAccount = (a: IPayoutAccount) => ({
  id: a._id,
  kind: a.kind,
  networkCode: a.networkCode ?? null,
  bankName: a.bankName ?? null,
  accountNumberMasked: `****${a.last4}`,
  last4: a.last4,
  accountName: a.accountName,
  currency: a.currency,
  label: a.label ?? null,
  status: a.status,
  isDefault: a.isDefault,
});

export const toWebPayoutMethod = (a: IPayoutAccount) => ({
  id: a._id,
  type: a.kind,
  network: a.networkCode ?? null,
  bankName: a.bankName ?? null,
  maskedAccount: `****${a.last4}`,
  accountName: a.accountName,
  currency: a.currency,
  label: a.label ?? null,
  verified: a.status === 'verified',
  default: a.isDefault,
});

const toMobileWithdrawal = (w: IWithdrawal) => ({
  id: w._id,
  reference: w.reference,
  status: w.status,
  amount: mobileMoney({ amountMinor: w.amountMinor, currency: w.currency }),
  fee: mobileMoney({ amountMinor: w.feeMinor, currency: w.currency }),
  account: w.accountDisplay,
  expectedBy: iso(w.expectedBy),
  failureReason: w.failureReason ?? null,
  requestedAt: iso(w.createdAt),
});

const toMobileLedger = (e: ILedgerEntry) => ({
  id: e._id,
  kind: e.kind,
  amount: mobileMoney({ amountMinor: e.amountMinor, currency: e.currency }),
  balanceAfter: mobileMoney({ amountMinor: e.balanceAfterMinor, currency: e.currency }),
  memo: e.memo ?? null,
  ref: e.refType && e.refId ? { type: e.refType, id: e.refId } : null,
  at: iso(e.createdAt),
});

/** Mobile /payouts/*. */
export function mobilePayoutsRouter(): Router {
  const r = Router();
  const acct = validate({ params: v.idParam });

  r.get('/payouts/balance', requireUser, ah(async (req, res) => {
    const w = await walletService.get(currentUserId(req));
    res.json({
      available: mobileMoney({ amountMinor: w.availableMinor, currency: w.currency }),
      escrow: mobileMoney({ amountMinor: w.escrowMinor, currency: w.currency }),
      pending: mobileMoney({ amountMinor: w.pendingMinor, currency: w.currency }),
    });
  }));

  r.get('/payouts/accounts', requireUser, ah(async (req, res) => {
    res.json({ data: (await svc.listAccounts(currentUserId(req))).map(toMobileAccount) });
  }));
  r.post('/payouts/accounts', requireUser, requireKyc, validate({ body: v.createAccountBody }), ah(async (req, res) => {
    res.status(201).json(toMobileAccount(await svc.createAccount(currentUserId(req), req.body)));
  }));
  r.get('/payouts/accounts/:accountId', requireUser, acct, ah(async (req, res) => {
    res.json(toMobileAccount(await svc.getAccount(currentUserId(req), String(req.params.accountId))));
  }));
  r.patch('/payouts/accounts/:accountId', requireUser, acct, validate({ body: v.patchAccountBody }), ah(async (req, res) => {
    res.json(toMobileAccount(await svc.patchAccount(currentUserId(req), String(req.params.accountId), req.body)));
  }));
  r.post('/payouts/accounts/:accountId/default', requireUser, acct, ah(async (req, res) => {
    res.json(toMobileAccount(await svc.setDefault(currentUserId(req), String(req.params.accountId))));
  }));
  // Contract path: PUT /payouts/accounts/{accountId}/default
  r.put('/payouts/accounts/:accountId/default', requireUser, acct, ah(async (req, res) => {
    res.json(toMobileAccount(await svc.setDefault(currentUserId(req), String(req.params.accountId))));
  }));
  r.delete('/payouts/accounts/:accountId', requireUser, acct, ah(async (req, res) => {
    await svc.deleteAccount(currentUserId(req), String(req.params.accountId));
    res.status(204).end();
  }));

  r.post('/payouts/withdrawals', requireUser, requireKyc, idempotencyKey(true), requireTransactionPin, validate({ body: v.withdrawalBody }), ah(async (req, res) => {
    const b = req.body as { accountId: string; amount: { amount: number; currency: string; scale?: number } };
    const money = parseCustomerMoney(b.amount);
    const out = await svc.requestWithdrawal({ userId: currentUserId(req), accountId: b.accountId, amountMinor: money.amountMinor, currency: money.currency, idempotencyKey: requireKeyOrThrow(req) });
    if (out.replayed) res.setHeader('Idempotent-Replay', 'true');
    res.status(201).json(toMobileWithdrawal(await svc.getWithdrawal(currentUserId(req), out.withdrawalId)));
  }));
  r.get('/payouts/withdrawals/:withdrawalId', requireUser, validate({ params: v.withdrawalIdParam }), ah(async (req, res) => {
    res.json(toMobileWithdrawal(await svc.getWithdrawal(currentUserId(req), String(req.params.withdrawalId))));
  }));

  r.get('/payouts/history', requireUser, validate({ query: v.historyQuery }), ah(async (req, res) => {
    const win = cursorWindow(req.query as { limit?: unknown; cursor?: unknown });
    const { rows, total } = await svc.history(currentUserId(req), req.query.kind as ILedgerEntry['kind'] | undefined, win.skip, win.limit);
    res.json(buildCursorPage(rows.map(toMobileLedger), total, win));
  }));

  return r;
}


