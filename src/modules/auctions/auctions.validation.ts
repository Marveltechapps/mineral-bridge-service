import { z } from 'zod';

export const auctionIdParam = z.object({ auctionId: z.string().min(1) });

const moneyIn = z.object({
  amount: z.number().int().positive(),
  currency: z.string().length(3).default('USD'),
  scale: z.number().int().optional(),
});

const boolish = z
  .union([z.literal('true'), z.literal('false'), z.boolean()])
  .optional()
  .transform((v) => v === true || v === 'true');

export const mobileListQuery = z.object({
  status: z.enum(['live', 'upcoming', 'ended']).default('live'),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

export const webListQuery = z.object({
  state: z
    .union([z.enum(['live', 'upcoming', 'ended']), z.array(z.enum(['live', 'upcoming', 'ended']))])
    .optional()
    .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v])),
  page: z.coerce.number().int().min(1).optional(),
  perPage: z.coerce.number().int().min(1).max(100).optional(),
});

export const bidsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  perPage: z.coerce.number().int().min(1).max(100).optional(),
});

/** Mobile: amount + optimistic `version` + explicit binding acknowledgement. */
export const mobileBidBody = z.object({
  amount: moneyIn,
  version: z.number().int().min(0),
  acceptBinding: z.literal(true, { errorMap: () => ({ message: 'You must accept that bids are binding' }) }),
});

/** Web: plain `{ amount }`. */
export const webBidBody = z.object({ amount: moneyIn });

export const autoBidBody = z.object({ ceiling: moneyIn });
export const reminderBody = z
  .object({ channels: z.array(z.enum(['email', 'sms', 'push'])).optional() })
  .default({});

export const watchBody = z.object({ notifyOnSimilar: boolish }).default({});

export const myBidsQuery = z.object({
  status: z.enum(['active', 'won', 'lost']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});
