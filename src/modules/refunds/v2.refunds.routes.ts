import { Router } from 'express';
import { z } from 'zod';
import { requireKeyOrThrow } from '../../common/middleware/idempotency-key.js';
import { validate } from '../../common/middleware/validate.js';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { getUserContext, requireUser } from '../auth/auth.middleware.js';
import { v2RefundsService } from './v2.refunds.service.js';

const destinationSchema = z.object({
  method: z.enum(['original', 'bank', 'upi', 'btc']),
  holder: z.string().min(2).max(120).optional(),
  bankName: z.string().min(2).max(120).optional(),
  accountMasked: z.string().optional(),
  accountEnc: z.string().optional(),
  swiftOrIfsc: z.string().optional(),
  country: z.string().optional(),
  upiId: z.string().optional(),
  btcAddress: z.string().optional(),
  label: z.string().optional(),
});

export function createV2RefundsRouter(): Router {
  const r = Router();
  r.use(requireUser);

  r.get(
    '/',
    validate({
      query: z.object({
        status: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const { user } = getUserContext(req);
      const q = req.query as { status?: string; cursor?: string; limit?: number };
      const skip = q.cursor ? Number.parseInt(q.cursor, 10) || 0 : 0;
      res.json(await v2RefundsService.listForUser(user.id, q.status, skip, q.limit ?? 24));
    }),
  );

  r.get(
    '/:ref',
    asyncHandler(async (req, res) => {
      const { user } = getUserContext(req);
      res.json(await v2RefundsService.getForUser(user.id, String(req.params.ref)));
    }),
  );

  return r;
}

export const refundRequestBody = z.object({
  type: z.enum(['full', 'partial']),
  amountMinor: z.number().int().positive().optional(),
  reason: z.enum([
    'delivery_delayed',
    'quantity_quality',
    'damaged',
    'damaged_in_transit',
    'paid_twice',
    'no_longer_needed',
    'other',
  ]),
  note: z.string().min(10).max(2000),
  destination: destinationSchema,
  attachmentFileIds: z.array(z.string()).max(10).optional(),
  cancelOrder: z.boolean().optional(),
  agree: z.literal(true),
});

export { requireKeyOrThrow };
