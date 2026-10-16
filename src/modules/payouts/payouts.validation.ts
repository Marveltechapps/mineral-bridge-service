import { z } from 'zod';

export const idParam = z.object({ accountId: z.string().min(1) });
export const withdrawalIdParam = z.object({ withdrawalId: z.string().min(1) });

export const createAccountBody = z.object({
  kind: z.enum(['bank', 'mobile_money', 'btc']).default('bank'),
  networkCode: z.string().max(40).optional(),
  bankName: z.string().max(120).optional(),
  accountNumber: z.string().min(4).max(64),
  accountName: z.string().min(2).max(120),
  currency: z.string().length(3).default('USD'),
  label: z.string().max(60).optional(),
  makeDefault: z.boolean().optional(),
});

export const patchAccountBody = z.object({ label: z.string().max(60).optional(), accountName: z.string().min(2).max(120).optional() });

export const withdrawalBody = z.object({
  accountId: z.string().min(1),
  amount: z.object({ amount: z.number().int().positive(), currency: z.string().length(3).default('USD'), scale: z.number().int().optional() }),
});

export const historyQuery = z.object({
  kind: z.enum(['withdrawal', 'sale_proceeds', 'escrow_hold', 'escrow_release', 'refund', 'adjustment']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});
