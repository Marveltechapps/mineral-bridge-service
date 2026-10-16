import { defineModel, pk } from './_shared.js';

export type PayoutAccountStatus = 'pending_verification' | 'verified' | 'failed';

/** Mobile `/payouts/accounts` and web `/account/payout-methods` share this one collection. */
export interface IPayoutAccount {
  _id: string;
  userId: string;
  kind: 'bank' | 'mobile_money' | 'btc';
  networkCode?: string; // bank code or mobile-money network
  bankName?: string;
  accountNumber: string;
  last4: string;
  accountName: string;
  currency: string;
  label?: string;
  status: PayoutAccountStatus;
  isDefault: boolean;
  fingerprint: string;
  deletedAt?: Date;
  createdAt: Date;
}

export const PayoutAccountModel = defineModel<IPayoutAccount>(
  'PayoutAccount',
  {
    _id: pk('pac'),
    userId: { type: String, required: true },
    kind: { type: String, enum: ['bank', 'mobile_money', 'btc'], default: 'bank' },
    networkCode: String,
    bankName: String,
    accountNumber: { type: String, required: true, select: false },
    last4: { type: String, required: true },
    accountName: { type: String, required: true },
    currency: { type: String, default: 'USD' },
    label: String,
    status: { type: String, enum: ['pending_verification', 'verified', 'failed'], default: 'pending_verification' },
    isDefault: { type: Boolean, default: false },
    fingerprint: { type: String, required: true },
    deletedAt: Date,
  },
  {
    indexes: [
      // MongoDB partial indexes cannot express `deletedAt: {$exists:false}` (index creation fails), so uniqueness of live
      // accounts is enforced by payouts.service (it checks before insert); this index only serves that lookup.
      [{ userId: 1, fingerprint: 1 }],
      [{ userId: 1, isDefault: 1 }],
    ],
  },
);

export interface IWallet {
  _id: string; // userId
  currency: string;
  availableMinor: number;
  escrowMinor: number;
  pendingMinor: number;
  version: number;
}

export const WalletModel = defineModel<IWallet>('Wallet', {
  _id: { type: String },
  currency: { type: String, default: 'USD' },
  availableMinor: { type: Number, default: 0, min: 0 },
  escrowMinor: { type: Number, default: 0, min: 0 },
  pendingMinor: { type: Number, default: 0, min: 0 },
  version: { type: Number, default: 0 },
});

export type WithdrawalStatus = 'requested' | 'processing' | 'paid' | 'failed' | 'cancelled';

export interface IWithdrawal {
  _id: string;
  reference: string;
  userId: string;
  accountId: string;
  accountDisplay: string;
  amountMinor: number;
  feeMinor: number;
  currency: string;
  status: WithdrawalStatus;
  expectedBy?: Date;
  failureReason?: string;
  createdAt: Date;
}

export const WithdrawalModel = defineModel<IWithdrawal>(
  'Withdrawal',
  {
    _id: pk('pay'),
    reference: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    accountId: { type: String, required: true },
    accountDisplay: String,
    amountMinor: { type: Number, required: true },
    feeMinor: { type: Number, default: 0 },
    currency: { type: String, default: 'USD' },
    status: { type: String, enum: ['requested', 'processing', 'paid', 'failed', 'cancelled'], default: 'requested' },
    expectedBy: Date,
    failureReason: String,
  },
  { indexes: [[{ userId: 1, createdAt: -1 }]] },
);

export interface ILedgerEntry {
  _id: string;
  userId: string;
  kind: 'withdrawal' | 'sale_proceeds' | 'escrow_hold' | 'escrow_release' | 'refund' | 'adjustment';
  amountMinor: number; // signed: negative debits
  currency: string;
  balanceAfterMinor: number;
  refType?: string;
  refId?: string;
  memo?: string;
  createdAt: Date;
}

export const LedgerModel = defineModel<ILedgerEntry>(
  'LedgerEntry',
  {
    _id: pk('led'),
    userId: { type: String, required: true },
    kind: { type: String, required: true },
    amountMinor: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    balanceAfterMinor: { type: Number, required: true },
    refType: String,
    refId: String,
    memo: String,
  },
  {
    indexes: [
      [{ userId: 1, createdAt: -1 }],
      // Exactly-once crediting per business event: the unique key is the claim, not an exists() check.
      [{ userId: 1, kind: 1, refType: 1, refId: 1 }, { unique: true, partialFilterExpression: { refId: { $type: 'string' } } }],
    ],
  },
);
