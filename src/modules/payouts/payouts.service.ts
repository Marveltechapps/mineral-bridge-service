import { createHash } from 'node:crypto';
import { conflict, notFound, unprocessable } from '../../common/errors/app-error.js';
import { idempotencyScope, runIdempotent } from '../../common/idempotency/idempotency.js';
import { addMs, DAY_MS, now } from '../../common/utils/clock.js';
import { references } from '../../common/utils/references.js';
import { LedgerModel, PayoutAccountModel, WalletModel, WithdrawalModel } from '../../models/payout.model.js';
import type { ILedgerEntry, IPayoutAccount, IWallet, IWithdrawal } from '../../models/payout.model.js';

export const WITHDRAWAL_FEE_BPS = 50;
export const WITHDRAWAL_MIN_FEE_MINOR = 50;

export const withdrawalFee = (amountMinor: number) => Math.max(WITHDRAWAL_MIN_FEE_MINOR, Math.round((amountMinor * WITHDRAWAL_FEE_BPS) / 10_000));

const fingerprint = (a: { kind: string; networkCode?: string; accountNumber: string }) =>
  createHash('sha256').update(`${a.kind}|${a.networkCode ?? ''}|${a.accountNumber.replace(/\s+/g, '')}`).digest('hex');

export const accountDisplay = (a: Pick<IPayoutAccount, 'bankName' | 'networkCode' | 'kind' | 'last4'>) =>
  `${a.bankName ?? a.networkCode ?? a.kind} ****${a.last4}`;

export const walletService = {
  async get(userId: string): Promise<IWallet> {
    const w = await WalletModel.findOneAndUpdate({ _id: userId }, { $setOnInsert: { currency: 'USD', availableMinor: 0, escrowMinor: 0, pendingMinor: 0, version: 0 } }, { upsert: true, new: true }).lean<IWallet>();
    return w!;
  },

  /** Atomic credit + ledger row. efType/refId/kind makes crediting the same event twice a no-op. */
  async credit(userId: string, amountMinor: number, currency: string, kind: ILedgerEntry['kind'], ref?: { type: string; id: string }, memo?: string) {
    await this.get(userId);
    // 1) Claim the event with the ledger row (unique on userId+kind+ref). A duplicate means it was already credited.
    //    balanceAfterMinor = -1 marks a claimed-but-not-yet-applied row (reconciliation can find crashes between 1 and 2).
    let entryId: string;
    try {
      entryId = (await LedgerModel.create({ userId, kind, amountMinor, currency, balanceAfterMinor: -1, refType: ref?.type, refId: ref?.id, memo }))._id as string;
    } catch (err) {
      if (ref && (err as { code?: number }).code === 11000) return;
      throw err;
    }
    // 2) Apply to the wallet, then 3) stamp the resulting balance on the row.
    const w = await WalletModel.findOneAndUpdate({ _id: userId }, { $inc: { availableMinor: amountMinor, version: 1 } }, { new: true }).lean<IWallet>();
    await LedgerModel.updateOne({ _id: entryId }, { $set: { balanceAfterMinor: w!.availableMinor } });
  },

  /** Atomic conditional debit: never lets the balance go negative under concurrency. */
  async debit(userId: string, amountMinor: number): Promise<IWallet> {
    const w = await WalletModel.findOneAndUpdate({ _id: userId, availableMinor: { $gte: amountMinor } }, { $inc: { availableMinor: -amountMinor, version: 1 } }, { new: true }).lean<IWallet>();
    if (!w) throw unprocessable('Insufficient available balance', { amount: 'Exceeds available balance' }, 'payout/insufficient-funds');
    return w;
  },
};

export const payoutsService = {
  listAccounts: (userId: string) => PayoutAccountModel.find({ userId, deletedAt: { $exists: false } }).sort({ isDefault: -1, createdAt: 1 }).lean<IPayoutAccount[]>(),

  async getAccount(userId: string, id: string): Promise<IPayoutAccount> {
    const a = await PayoutAccountModel.findOne({ _id: id, userId, deletedAt: { $exists: false } }).lean<IPayoutAccount>();
    if (!a) throw notFound('payout/account-not-found', 'Payout account not found');
    return a;
  },

  async createAccount(userId: string, input: { kind: IPayoutAccount['kind']; networkCode?: string; bankName?: string; accountNumber: string; accountName: string; currency: string; label?: string; makeDefault?: boolean }) {
    const fp = fingerprint(input);
    if (await PayoutAccountModel.exists({ userId, fingerprint: fp, deletedAt: { $exists: false } })) {
      throw conflict('payout/account-exists', 'This payout account is already saved');
    }
    const hasAny = await PayoutAccountModel.exists({ userId, deletedAt: { $exists: false } });
    const digits = input.accountNumber.replace(/\s+/g, '');
    try {
      const doc = await PayoutAccountModel.create({
        userId,
        kind: input.kind,
        networkCode: input.networkCode,
        bankName: input.bankName,
        accountNumber: digits,
        last4: digits.slice(-4),
        accountName: input.accountName,
        currency: input.currency,
        label: input.label,
        // Name-enquiry is stubbed: accounts are verified on creation. Swap for the bank/PSP lookup.
        status: 'verified',
        isDefault: !hasAny,
        fingerprint: fp,
      });
      if (input.makeDefault && hasAny) await this.setDefault(userId, doc._id);
      return this.getAccount(userId, doc._id);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw conflict('payout/account-exists', 'This payout account is already saved');
      throw err;
    }
  },

  async patchAccount(userId: string, id: string, patch: { label?: string; accountName?: string }) {
    await this.getAccount(userId, id);
    await PayoutAccountModel.updateOne({ _id: id, userId }, { $set: patch });
    return this.getAccount(userId, id);
  },

  async setDefault(userId: string, id: string) {
    await this.getAccount(userId, id);
    await PayoutAccountModel.updateMany({ userId, _id: { $ne: id } }, { $set: { isDefault: false } });
    await PayoutAccountModel.updateOne({ _id: id, userId }, { $set: { isDefault: true } });
    return this.getAccount(userId, id);
  },

  async deleteAccount(userId: string, id: string) {
    const a = await this.getAccount(userId, id);
    const pending = await WithdrawalModel.exists({ accountId: id, status: { $in: ['requested', 'processing'] } });
    if (pending) throw conflict('payout/account-in-use', 'This account has a withdrawal in progress');
    await PayoutAccountModel.updateOne({ _id: id, userId }, { $set: { deletedAt: now(), isDefault: false } });
    if (a.isDefault) {
      const next = await PayoutAccountModel.findOne({ userId, deletedAt: { $exists: false } }).sort({ createdAt: 1 }).lean<IPayoutAccount>();
      if (next) await PayoutAccountModel.updateOne({ _id: next._id }, { $set: { isDefault: true } });
    }
  },

  async requestWithdrawal(input: { userId: string; accountId: string; amountMinor: number; currency: string; idempotencyKey: string }) {
    const out = await runIdempotent<{ withdrawalId: string }>({
      scope: idempotencyScope(input.userId, 'withdrawal'),
      key: input.idempotencyKey,
      body: { accountId: input.accountId, amountMinor: input.amountMinor, currency: input.currency },
      successStatus: 201,
      fn: async () => ({ withdrawalId: await this.requestOnce(input) }),
    });
    return { withdrawalId: out.result.withdrawalId, replayed: out.replayed };
  },

  async requestOnce(input: { userId: string; accountId: string; amountMinor: number; currency: string }): Promise<string> {
    const account = await this.getAccount(input.userId, input.accountId);
    if (account.status !== 'verified') throw conflict('payout/account-not-verified', 'This payout account is not verified yet');
    const wallet = await walletService.get(input.userId);
    if (input.currency !== wallet.currency) throw unprocessable(`Withdrawals are in ${wallet.currency}`, { currency: `Must be ${wallet.currency}` });
    const fee = withdrawalFee(input.amountMinor);
    const after = await walletService.debit(input.userId, input.amountMinor + fee);
    try {
      const w = await WithdrawalModel.create({
        reference: await references.withdrawal(),
        userId: input.userId,
        accountId: account._id,
        accountDisplay: accountDisplay(account),
        amountMinor: input.amountMinor,
        feeMinor: fee,
        currency: input.currency,
        status: 'processing',
        expectedBy: addMs(now(), 2 * DAY_MS),
      });
      await LedgerModel.create({
        userId: input.userId,
        kind: 'withdrawal',
        amountMinor: -(input.amountMinor + fee),
        currency: input.currency,
        balanceAfterMinor: after.availableMinor,
        refType: 'withdrawal',
        refId: w._id,
        memo: `Withdrawal to ${accountDisplay(account)}`,
      });
      return w._id;
    } catch (err) {
      // Compensate so a failed insert never burns the user's money.
      await WalletModel.updateOne({ _id: input.userId }, { $inc: { availableMinor: input.amountMinor + fee, version: 1 } });
      throw err;
    }
  },

  async getWithdrawal(userId: string, id: string): Promise<IWithdrawal> {
    const w = await WithdrawalModel.findOne({ _id: id, userId }).lean<IWithdrawal>();
    if (!w) throw notFound('payout/withdrawal-not-found', 'Withdrawal not found');
    return w;
  },

  async history(userId: string, kind: ILedgerEntry['kind'] | undefined, skip: number, limit: number) {
    const filter = { userId, ...(kind ? { kind } : {}) };
    const [rows, total] = await Promise.all([
      LedgerModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean<ILedgerEntry[]>(),
      LedgerModel.countDocuments(filter),
    ]);
    return { rows, total };
  },
};
