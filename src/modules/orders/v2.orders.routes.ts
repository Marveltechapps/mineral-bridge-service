import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../common/middleware/validate.js';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { clientIp } from '../auth/auth.http.js';
import { getUserContext, requireUser } from '../auth/auth.middleware.js';
import { idempotencyKey, requireKeyOrThrow } from '../../common/middleware/idempotency-key.js';
import { idempotencyScope, runIdempotent } from '../../common/idempotency/idempotency.js';
import { v2ContractService } from './v2.contract.service.js';
import { v2LifecycleService } from './v2.lifecycle.service.js';
import { v2PaymentsService } from './v2.payments.service.js';
import { v2OrdersService } from './v2.orders.service.js';
import { v2OrderChatService } from './v2.chat.service.js';
import { v2ChangesService } from './v2.changes.service.js';
import { v2VariationService } from './v2.variation.service.js';
import { v2DocumentsService } from '../documents/v2.documents.service.js';
import { v2RefundsService } from '../refunds/v2.refunds.service.js';
import { refundRequestBody } from '../refunds/v2.refunds.routes.js';

const qtySchema = z.object({
  value: z.union([z.string(), z.number()]),
  unit: z.enum(['g', 'kg', 't', 'ct']),
});

const deliverySchema = z.object({
  org: z.string().trim().min(2).max(160),
  street: z.string().trim().min(2).max(240),
  city: z.string().trim().min(2).max(120),
  region: z.string().trim().max(120).optional(),
  country: z.string().regex(/^[A-Z]{2}$/),
  contact: z.string().trim().min(2).max(120),
  mobile: z.string().min(9).max(20),
});

const createBody = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('buy'),
    fromCart: z.boolean().optional(),
    items: z
      .array(z.object({ productRef: z.string().min(1), qty: qtySchema }))
      .min(1)
      .max(10)
      .optional(),
    delivery: deliverySchema,
  }),
  z.object({
    kind: z.literal('sell'),
    sell: z.object({
      mineral: z.string().min(1).max(80),
      name: z.string().max(160).optional(),
      qty: qtySchema,
      grade: z.string().min(1).max(80),
      form: z.enum(['Raw', 'Semi-finished', 'Finished']),
      details: z.string().min(10).max(2000),
      photoFileIds: z.array(z.string()).min(3).max(20),
      documentFileIds: z.array(z.string()).max(10).optional(),
    }),
  }),
]);

const listQuery = z.object({
  kind: z.enum(['buy', 'sell', 'auction']).optional(),
  state: z.enum(['open', 'done', 'cancelled']).optional(),
  actionNeeded: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

const versionBody = z.object({ version: z.number().int().nonnegative() });

export function createV2OrdersRouter(): Router {
  const r = Router();
  r.use(requireUser);

  r.post('/', idempotencyKey(true), validate({ body: createBody }), asyncHandler(async (req, res) => {
    const { user } = getUserContext(req);
    const body = req.body as z.infer<typeof createBody>;
    // The key is required, so honour it: a retried or double-submitted create returns the first order
    // instead of creating a duplicate (same key + different body -> 409 idempotency/key-reused).
    const outcome = await runIdempotent<unknown>({
      scope: idempotencyScope(user.id, 'v2-order:create'),
      key: requireKeyOrThrow(req),
      body,
      successStatus: 201,
      fn: async () => {
        const created = body.kind === 'buy'
          ? await v2OrdersService.createBuy({ userId: user.id, fromCart: body.fromCart, items: body.items, delivery: body.delivery })
          : await v2OrdersService.createSell({ userId: user.id, sell: body.sell });
        return JSON.parse(JSON.stringify(created)) as unknown;
      },
    });
    if (outcome.replayed) res.setHeader('Idempotent-Replay', 'true');
    res.status(outcome.status).json(outcome.result);
  }));

  r.get('/', validate({ query: listQuery }), asyncHandler(async (req, res) => {
    const { user } = getUserContext(req);
    const q = req.query as z.infer<typeof listQuery>;
    res.json(await v2OrdersService.list({
      userId: user.id, kind: q.kind, state: q.state, actionNeeded: q.actionNeeded, limit: q.limit, cursor: q.cursor,
    }));
  }));

  r.get('/:ref', asyncHandler(async (req, res) => {
    res.json(await v2OrdersService.get(getUserContext(req).user.id, String(req.params.ref)));
  }));

  r.post('/:ref/quotation/accept', validate({ body: z.object({ quotationNumber: z.string().min(1), version: z.number().int() }) }), asyncHandler(async (req, res) => {
    const { user } = getUserContext(req);
    const b = req.body as { quotationNumber: string; version: number };
    res.json(await v2OrdersService.acceptQuotation({ userId: user.id, ref: String(req.params.ref), ...b }));
  }));

  r.post('/:ref/quotation/decline', validate({ body: z.object({ quotationNumber: z.string().min(1), version: z.number().int(), reason: z.string().max(500).optional() }) }), asyncHandler(async (req, res) => {
    const { user } = getUserContext(req);
    const b = req.body as { quotationNumber: string; version: number; reason?: string };
    res.json(await v2OrdersService.declineQuotation({ userId: user.id, ref: String(req.params.ref), ...b }));
  }));

  r.get('/:ref/contract', asyncHandler(async (req, res) => {
    res.json(await v2ContractService.getOrCreate(getUserContext(req).user.id, String(req.params.ref)));
  }));

  r.post('/:ref/contract/sign', validate({ body: z.object({
    documentHash: z.string().min(10),
    nameTyped: z.string().min(2).max(160),
    readConfirmed: z.literal(true),
    version: z.number().int(),
  }) }), asyncHandler(async (req, res) => {
    const { user } = getUserContext(req);
    const b = req.body as { documentHash: string; nameTyped: string; readConfirmed: true; version: number };
    res.json(await v2ContractService.sign(user.id, String(req.params.ref), {
      ...b, ip: clientIp(req), userAgent: req.header('user-agent') ?? undefined,
    }));
  }));

  r.post('/:ref/buyer-form', validate({ body: z.object({
    method: z.string().min(1),
    terms: z.enum(['advance_100', 'advance_30_70', 'lc_at_sight']),
    billing: z.object({ name: z.string().min(1), address: z.string().min(1) }),
    instructions: z.string().max(2000).optional(),
    confirmed: z.literal(true),
    version: z.number().int(),
  }) }), asyncHandler(async (req, res) => {
    res.json(await v2PaymentsService.submitBuyerForm(getUserContext(req).user.id, String(req.params.ref), req.body));
  }));

  r.post('/:ref/payments/btc-quote', asyncHandler(async (req, res) => {
    res.status(201).json(await v2PaymentsService.btcQuote(getUserContext(req).user.id, String(req.params.ref)));
  }));

  r.post('/:ref/payments', validate({ body: z.object({
    method: z.enum(['bank_transfer', 'neft', 'rtgs', 'upi', 'net_banking', 'btc', 'lc', 'other']),
    proofFileIds: z.array(z.string()).optional(),
    btcTxid: z.string().optional(),
    reference: z.string().optional(),
    terms: z.string().optional(),
    billing: z.object({ name: z.string(), address: z.string() }).optional(),
    version: z.number().int(),
  }) }), asyncHandler(async (req, res) => {
    res.status(201).json(await v2PaymentsService.submit(getUserContext(req).user.id, String(req.params.ref), req.body));
  }));

  r.post('/:ref/seller-form', validate({ body: z.object({
    payout: z.record(z.unknown()),
    inspectionSlot: z.object({ date: z.string(), time: z.string(), address: z.string().min(5).max(300) }),
    confirmed: z.literal(true),
    version: z.number().int(),
  }) }), asyncHandler(async (req, res) => {
    res.json(await v2LifecycleService.sellerForm(getUserContext(req).user.id, String(req.params.ref), req.body));
  }));

  r.post('/:ref/inspection-reports/accept', validate({ body: versionBody }), asyncHandler(async (req, res) => {
    res.json(await v2LifecycleService.acceptInspection(getUserContext(req).user.id, String(req.params.ref), req.body.version));
  }));

  r.post('/:ref/inspection-reports/query', validate({ body: versionBody.extend({ note: z.string().min(5).max(2000) }) }), asyncHandler(async (req, res) => {
    const b = req.body as { note: string; version: number };
    res.json(await v2LifecycleService.queryInspection(getUserContext(req).user.id, String(req.params.ref), b.note, b.version));
  }));

  r.post('/:ref/receipt', validate({ body: z.object({
    qtyReceived: qtySchema,
    condition: z.enum(['good', 'minor_damage', 'damaged']),
    photoFileIds: z.array(z.string()).min(1),
    note: z.string().max(2000).optional(),
    version: z.number().int(),
  }) }), asyncHandler(async (req, res) => {
    res.json(await v2LifecycleService.acceptDelivery(getUserContext(req).user.id, String(req.params.ref), req.body));
  }));

  r.post('/:ref/receipt/dispute', validate({ body: z.object({
    qtyReceived: qtySchema,
    condition: z.string(),
    photoFileIds: z.array(z.string()).min(1),
    note: z.string().min(5).max(2000),
    version: z.number().int(),
  }) }), asyncHandler(async (req, res) => {
    res.json(await v2LifecycleService.disputeDelivery(getUserContext(req).user.id, String(req.params.ref), req.body));
  }));

  r.get('/:ref/cancellation', asyncHandler(async (req, res) => {
    res.json(await v2LifecycleService.cancellationEligibility(getUserContext(req).user.id, String(req.params.ref)));
  }));

  r.post('/:ref/cancel', validate({ body: z.object({
    reason: z.string().min(1),
    note: z.string().optional(),
    agree: z.literal(true),
    version: z.number().int(),
  }) }), asyncHandler(async (req, res) => {
    res.json(await v2LifecycleService.cancel(getUserContext(req).user.id, String(req.params.ref), req.body));
  }));

  r.get('/:ref/shipment', asyncHandler(async (req, res) => {
    res.json(await v2LifecycleService.getShipment(getUserContext(req).user.id, String(req.params.ref)));
  }));

  r.get('/:ref/documents', asyncHandler(async (req, res) => {
    res.json(await v2DocumentsService.listForOrder(getUserContext(req).user.id, String(req.params.ref)));
  }));

  r.get('/:ref/messages', asyncHandler(async (req, res) => {
    const cursor = (req.query as { cursor?: string }).cursor;
    const skip = cursor ? Number.parseInt(cursor, 10) || 0 : 0;
    res.json(await v2OrderChatService.list(getUserContext(req).user.id, String(req.params.ref), skip));
  }));

  r.post('/:ref/messages', validate({ body: z.object({
    body: z.string().min(1).max(4000).optional(),
    attachmentFileIds: z.array(z.string()).max(5).optional(),
    offerMinor: z.number().int().positive().optional(),
  }).refine((b) => Boolean(b.body) || b.offerMinor != null, { message: 'body or offerMinor required' }) }), asyncHandler(async (req, res) => {
    const { user } = getUserContext(req);
    const b = req.body as { body?: string; attachmentFileIds?: string[]; offerMinor?: number };
    if (b.offerMinor != null) {
      const { v2NegotiationService } = await import('./v2.negotiation.service.js');
      await v2NegotiationService.postCustomer({
        userId: user.id,
        ref: String(req.params.ref),
        text: b.body,
        offerMinor: b.offerMinor,
      });
    }
    if (b.body) {
      res.status(201).json(await v2OrderChatService.post(user.id, String(req.params.ref), b.body, b.attachmentFileIds));
      return;
    }
    res.status(201).json({ ok: true, offerMinor: b.offerMinor });
  }));

  r.post('/:ref/changes', validate({ body: z.object({
    photoFileIds: z.array(z.string()).optional(),
    documentFileIds: z.array(z.string()).optional(),
    replaceFiles: z.record(z.string()).optional(),
    note: z.string().min(1).max(2000),
    version: z.number().int(),
    sellerForm: z.record(z.unknown()).optional(),
  }) }), asyncHandler(async (req, res) => {
    const { user } = getUserContext(req);
    res.json(await v2ChangesService.submit({ userId: user.id, ref: String(req.params.ref), ...req.body }));
  }));

  r.post('/:ref/price-variations/:variationId', validate({ body: z.object({
    decision: z.enum(['accept', 'reject']),
    note: z.string().max(2000).optional(),
    version: z.number().int(),
  }) }), asyncHandler(async (req, res) => {
    const { user } = getUserContext(req);
    const b = req.body as { decision: 'accept' | 'reject'; note?: string; version: number };
    res.json(await v2VariationService.respond({
      userId: user.id,
      ref: String(req.params.ref),
      variationId: String(req.params.variationId),
      ...b,
    }));
  }));

  r.post('/:ref/refunds', idempotencyKey(true), validate({ body: refundRequestBody }), asyncHandler(async (req, res) => {
    const { user } = getUserContext(req);
    const body = req.body as z.infer<typeof refundRequestBody>;
    const result = await v2RefundsService.request({
      userId: user.id,
      ref: String(req.params.ref),
      type: body.type,
      amountMinor: body.amountMinor,
      reason: body.reason,
      note: body.note,
      destination: body.destination,
      attachmentFileIds: body.attachmentFileIds,
      cancelOrder: body.cancelOrder,
      agree: true,
      idempotencyKey: requireKeyOrThrow(req),
    });
    if (result.replayed) res.setHeader('Idempotent-Replay', 'true');
    res.status(201).json(result.refund);
  }));

  return r;
}
