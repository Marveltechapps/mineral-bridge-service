import type { ClientSession } from 'mongoose';
import { nextId } from '../../../common/db/sequence.js';
import { percentOfMinor, type StoredMoney } from '../../../common/utils/money.js';
import { Settlement } from '../../../models/trading.models.js';

/** Platform fee in basis points by settlement kind (100 = 1%). */
export const FEE_BPS: Record<string, number> = {
  buy_settlement: 200,
  seller_payout: 100,
  auction_settlement: 200,
  btc_settlement: 100,
};

export async function createSettlement(input: {
  kind: 'buy_settlement' | 'seller_payout' | 'auction_settlement' | 'btc_settlement';
  ref: { type: string; id: string };
  partyId?: string;
  amount: StoredMoney;
  status?: 'released' | 'on_hold' | 'disputed' | 'pending';
  rail?: 'bank' | 'mpesa' | 'lightning' | 'on_chain';
  escrowRef?: string;
  createdBy?: string;
  date?: Date;
  session?: ClientSession;
}) {
  const settlementId = await nextId('settlement', input.session);
  const fee: StoredMoney = { ...input.amount, amountMinor: percentOfMinor(Math.abs(input.amount.amountMinor), FEE_BPS[input.kind] ?? 0) };
  await Settlement.create(
    [
      {
        settlementId,
        date: input.date ?? new Date(),
        ref: input.ref,
        partyId: input.partyId,
        kind: input.kind,
        amount: input.amount,
        usdEquivalent: input.amount.currency === 'USD' ? input.amount : undefined,
        feeAmount: fee,
        status: input.status ?? 'pending',
        rail: input.rail,
        escrowRef: input.escrowRef,
        createdBy: input.createdBy,
      },
    ],
    { session: input.session },
  );
  return settlementId;
}
