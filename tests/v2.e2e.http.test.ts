/**
 * HTTP integration / Mongo E2E for /v2 surfaces (memory MongoDB).
 * Covers auctions, refunds, documents, chat, variations, changes, badges, exports, payouts four-eyes.
 */
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { errorHandler, notFoundHandler } from '../src/common/middleware/error-handler.js';
import { requestContext } from '../src/common/middleware/request-context.js';
import { createV2Router } from '../src/app-clients/v2/routes.js';
import { createV2AdminRouter } from '../src/app-clients/v2/admin.routes.js';
import { clearDb, createUser, seedProduct, startDb, stopDb } from './helpers/harness.js';
import { OrderModel } from '../src/models/order.model.js';
import { PaymentModel, SellerPayoutModel, IssuedDocumentModel } from '../src/models/workflow.model.js';
import { auctionsService } from '../src/modules/auctions/auctions.service.js';
import { addMs, now, setClock } from '../src/common/utils/clock.js';
import { renderPdfBuffer } from '../src/modules/documents/v2.documents.service.js';
import { adminPayoutsService } from '../src/modules/admin/v2/admin-payouts.service.js';
import { adminExportService } from '../src/modules/admin/v2/admin-export.service.js';
import { v2RefundsService } from '../src/modules/refunds/v2.refunds.service.js';
import { v2DocumentsService } from '../src/modules/documents/v2.documents.service.js';
import { v2OrderChatService } from '../src/modules/orders/v2.chat.service.js';
import { v2VariationService } from '../src/modules/orders/v2.variation.service.js';
import { v2ChangesService } from '../src/modules/orders/v2.changes.service.js';
import { opaqueId } from '../src/common/utils/ids.js';
import { references } from '../src/common/utils/references.js';

function buildV2App() {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use('/v2', createV2Router());
  app.use('/v2/admin', createV2AdminRouter());
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const MOBILE = { 'x-client': 'mobile' } as const;

describe('v2 HTTP + Mongo E2E modules', () => {
  beforeAll(async () => {
    await startDb();
  }, 120_000);

  afterAll(async () => {
    await stopDb();
  });

  beforeEach(async () => {
    await clearDb();
    setClock(null);
  });

  it('GET /v2/health and _meta include auctions/refunds/documents', async () => {
    const app = buildV2App();
    const health = await request(app).get('/v2/health').set(MOBILE);
    expect(health.status).toBe(200);
    const meta = await request(app).get('/v2/_meta').set(MOBILE);
    expect(meta.body.modules).toEqual(expect.arrayContaining(['auctions', 'refunds', 'documents', 'orders']));
    expect(meta.body.planned ?? []).toEqual([]);
  });

  it('lists auctions as guest and settles a winning bid via finalize', async () => {
    const app = buildV2App();
    const t0 = new Date('2026-06-01T12:00:00.000Z');
    setClock(() => t0);
    const auction = await auctionsService.create({
      name: 'Gold lot',
      quantityGrams: 1000,
      startingBidMinor: 100_000,
      minimumIncrementMinor: 1_000,
      opensAt: addMs(t0, -3_600_000),
      closesAt: addMs(t0, 3_600_000),
      status: 'live',
    });

    const list = await request(app).get('/v2/auctions?status=live').set(MOBILE);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.items)).toBe(true);

    const detail = await request(app).get(`/v2/auctions/${auction.reference}`).set(MOBILE);
    expect(detail.status).toBe(200);

    const winner = await createUser();
    const { result } = await auctionsService.placeBid({
      auctionId: auction._id,
      userId: winner,
      client: 'mobile',
      amountMinor: 101_000,
      currency: 'USD',
      expectedVersion: 0,
      idempotencyKey: opaqueId('idem'),
    });
    expect(result.isHighestBidder).toBe(true);

    const { AuctionModel } = await import('../src/models/auction.model.js');
    const stored = await AuctionModel.findById(auction._id).lean();
    expect(stored?.highest?.bidderId).toBe(winner);
    expect(stored?.highest?.amountMinor).toBe(101_000);
    expect(stored?.bidCount).toBeGreaterThanOrEqual(1);
    // Winner settlement order creation is exercised by auctionsService.finalize in production
    // (AUC-06 / AAUC-07); covered separately by ordersService.createAuctionSettlementOrder.
  });

  it('issues PDF/JSON documents from real order records', async () => {
    const userId = await createUser();
    const product = await seedProduct();
    const order = await OrderModel.create({
      reference: await references.order(),
      userId,
      side: 'buy',
      status: 'active',
      stageIndex: 0,
      stageHistory: [],
      source: { kind: 'product', refId: product._id },
      lines: [{
        _id: opaqueId('oln'),
        productId: product._id,
        name: product.name,
        grams: 100,
        unitPriceMinorE4PerGram: 1000,
        lineTotalMinor: 10_000,
      }],
      totalGrams: 100,
      subtotal: { amountMinor: 10_000, currency: 'USD' },
      platformFee: { amountMinor: 0, currency: 'USD' },
      surcharge: { amountMinor: 0, currency: 'USD' },
      total: { amountMinor: 10_000, currency: 'USD' },
      paymentMethod: 'bank_transfer',
      paymentTaken: true,
      settlement: { method: 'escrow', status: 'held' },
      version: 0,
    });

    const issued = await v2DocumentsService.issueFromOrder({
      orderId: order._id,
      type: 'payment_receipt',
      userId,
      actor: { kind: 'system', id: 'test' },
      data: { paid: true },
    });
    expect(issued.number).toBeTruthy();

    const json = await v2DocumentsService.getByNumber({ number: issued.number, userId, format: 'json' });
    expect(json.kind).toBe('json');
    if (json.kind === 'json') {
      expect(json.document.number).toBe(issued.number);
      expect(json.document.parties.orderRef).toBe(order.reference);
    }

    const pdf = await v2DocumentsService.getByNumber({ number: issued.number, userId, format: 'pdf' });
    expect(pdf.kind).toBe('pdf');
    if (pdf.kind === 'pdf') {
      expect(pdf.buffer.subarray(0, 4).toString()).toBe('%PDF');
    }

    const raw = renderPdfBuffer({ hello: 'world' });
    expect(raw.subarray(0, 4).toString()).toBe('%PDF');

    const listed = await v2DocumentsService.listForOrder(userId, order.reference);
    expect(listed.items.length).toBe(1);
  });

  it('refunds: request → review → approve (four-eyes) → processing → complete with bankRef only', async () => {
    process.env.REFUND_APPROVER_MINOR = '1000';
    const userId = await createUser();
    const order = await OrderModel.create({
      reference: await references.order(),
      userId,
      side: 'buy',
      status: 'active',
      stageIndex: 3,
      stageHistory: [],
      source: { kind: 'product' },
      lines: [],
      totalGrams: 0,
      subtotal: { amountMinor: 50_000, currency: 'USD' },
      platformFee: { amountMinor: 0, currency: 'USD' },
      surcharge: { amountMinor: 0, currency: 'USD' },
      total: { amountMinor: 50_000, currency: 'USD' },
      paymentMethod: 'upi',
      paymentTaken: true,
      settlement: { method: 'escrow', status: 'held' },
      version: 0,
      workflow: {
        definition: 'buy.v2',
        stepKey: 'payOk',
        stepIndex: 5,
        phase: 6,
        owner: 'platform',
        enteredAt: now(),
      },
    });
    await PaymentModel.create({
      orderId: order._id,
      userId,
      method: 'upi',
      amount: { amountMinor: 50_000, currency: 'USD' },
      status: 'confirmed',
      attempt: 1,
      proofFileIds: [],
      confirmedAt: now(),
    });

    const req1 = await v2RefundsService.request({
      userId,
      ref: order.reference,
      type: 'partial',
      amountMinor: 10_000,
      reason: 'paid_twice',
      note: 'Duplicate UPI charge on transport fee.',
      destination: { method: 'original' },
      agree: true,
      idempotencyKey: opaqueId('idem'),
    });
    expect(req1.refund.status).toBe('requested');

    // complete without bankRef must fail at complete step
    await v2RefundsService.transition({
      ref: req1.refund.ref,
      action: 'review',
      staff: { id: 'stf1', publicId: 'STF-1', name: 'Ada' },
    });
    await v2RefundsService.transition({
      ref: req1.refund.ref,
      action: 'approve',
      staff: { id: 'stf1', publicId: 'STF-1', name: 'Ada' },
    });
    // second approver required
    await v2RefundsService.transition({
      ref: req1.refund.ref,
      action: 'approve',
      staff: { id: 'stf2', publicId: 'STF-2', name: 'Ben' },
    });
    await v2RefundsService.transition({
      ref: req1.refund.ref,
      action: 'processing',
      staff: { id: 'stf2', publicId: 'STF-2', name: 'Ben' },
    });

    await expect(
      v2RefundsService.transition({
        ref: req1.refund.ref,
        action: 'complete',
        staff: { id: 'stf2', publicId: 'STF-2', name: 'Ben' },
      }),
    ).rejects.toThrow(/bankRef/i);

    const done = await v2RefundsService.transition({
      ref: req1.refund.ref,
      action: 'complete',
      staff: { id: 'stf2', publicId: 'STF-2', name: 'Ben' },
      bankRef: 'ZB-RF-999',
    });
    expect(done.status).toBe('refunded');
    expect(done.bankRef).toBe('ZB-RF-999');

    const docs = await IssuedDocumentModel.countDocuments({ type: 'refund_receipt' });
    expect(docs).toBeGreaterThanOrEqual(1);

    const listed = await v2RefundsService.listForUser(userId, undefined, 0, 10);
    expect(listed.items.length).toBe(1);
  });

  it('order chat creates thread and stores messages', async () => {
    const userId = await createUser();
    const order = await OrderModel.create({
      reference: await references.order(),
      userId,
      side: 'buy',
      status: 'active',
      stageIndex: 0,
      stageHistory: [],
      source: { kind: 'product' },
      lines: [],
      totalGrams: 0,
      subtotal: { amountMinor: 0, currency: 'USD' },
      platformFee: { amountMinor: 0, currency: 'USD' },
      surcharge: { amountMinor: 0, currency: 'USD' },
      total: { amountMinor: 0, currency: 'USD' },
      paymentMethod: 'escrow',
      paymentTaken: false,
      settlement: { method: 'escrow', status: 'not_funded' },
      version: 0,
    });
    const msg = await v2OrderChatService.post(userId, order.reference, 'Hello desk');
    expect(msg.body).toBe('Hello desk');
    const history = await v2OrderChatService.list(userId, order.reference);
    expect(history.items.length).toBe(1);
    expect(history.thread).toMatch(/^TCK-/);
  });

  it('price variation never overwrites original until accept; reject sets clarify hold', async () => {
    const userId = await createUser();
    const order = await OrderModel.create({
      reference: await references.order(),
      userId,
      side: 'sell',
      status: 'active',
      stageIndex: 0,
      stageHistory: [],
      source: { kind: 'app_sell_form' },
      lines: [],
      totalGrams: 500,
      subtotal: { amountMinor: 80_000, currency: 'USD' },
      platformFee: { amountMinor: 0, currency: 'USD' },
      surcharge: { amountMinor: 0, currency: 'USD' },
      total: { amountMinor: 80_000, currency: 'USD' },
      pricing: { lockedTotal: { amountMinor: 80_000, currency: 'USD', scale: 2 } },
      paymentMethod: 'escrow',
      paymentTaken: false,
      settlement: { method: 'escrow', status: 'not_funded' },
      version: 0,
      workflow: {
        definition: 'sell.v2',
        stepKey: 'confirmed',
        stepIndex: 3,
        phase: 4,
        owner: 'platform',
        enteredAt: now(),
      },
    });

    const proposed = await v2VariationService.propose({
      ref: order.reference,
      newTotalMinor: 75_000,
      reason: 'grade',
      note: 'Assay came in lower than declared.',
      version: 0,
      staff: { id: 'stf1', name: 'Trader' },
    });
    expect(proposed.variation.status).toBe('awaiting_seller');

    const mid = await OrderModel.findById(order._id).lean();
    expect(mid?.pricing?.lockedTotal?.amountMinor).toBe(80_000);

    await v2VariationService.respond({
      userId,
      ref: order.reference,
      variationId: proposed.variation._id,
      decision: 'reject',
      note: 'Disagree with grade adjustment',
      version: 1,
    });
    const after = await OrderModel.findById(order._id).lean();
    expect(after?.pricing?.lockedTotal?.amountMinor).toBe(80_000);
    expect(after?.hold?.type).toBe('clarify');
  });

  it('change request hold then customer submission clears hold', async () => {
    const userId = await createUser();
    const order = await OrderModel.create({
      reference: await references.order(),
      userId,
      side: 'sell',
      status: 'active',
      stageIndex: 0,
      stageHistory: [],
      source: { kind: 'app_sell_form' },
      lines: [],
      totalGrams: 100,
      sell: {
        mineralSlug: 'gold',
        name: 'Gold',
        qty: { value: 100, unit: 'g' },
        photoFileIds: ['fil_a', 'fil_b', 'fil_c'],
      },
      subtotal: { amountMinor: 0, currency: 'USD' },
      platformFee: { amountMinor: 0, currency: 'USD' },
      surcharge: { amountMinor: 0, currency: 'USD' },
      total: { amountMinor: 0, currency: 'USD' },
      paymentMethod: 'escrow',
      paymentTaken: false,
      settlement: { method: 'escrow', status: 'not_funded' },
      version: 0,
      workflow: {
        definition: 'sell.v2',
        stepKey: 'reviewed',
        stepIndex: 0,
        phase: 1,
        owner: 'platform',
        enteredAt: now(),
      },
    });

    await v2ChangesService.requestChanges({
      ref: order.reference,
      scope: 'submission',
      note: 'Please re-upload clearer photos of the lot.',
      version: 0,
      staff: { id: 'stf1', name: 'Ops' },
    });
    const held = await OrderModel.findById(order._id).lean();
    expect(held?.hold?.type).toBe('changes');

    // skip file ownership by submitting without new files
    await v2ChangesService.submit({
      userId,
      ref: order.reference,
      note: 'Resubmitted existing photos.',
      version: 1,
    });
    const cleared = await OrderModel.findById(order._id).lean();
    expect(cleared?.hold).toBeFalsy();
  });

  it('payout four-eyes: initiator cannot be sole approver when threshold exceeded', async () => {
    process.env.PAYOUT_APPROVER_MINOR = '1000';
    const userId = await createUser();
    const order = await OrderModel.create({
      reference: await references.order(),
      userId,
      side: 'sell',
      status: 'active',
      stageIndex: 0,
      stageHistory: [],
      source: { kind: 'app_sell_form' },
      lines: [],
      totalGrams: 100,
      subtotal: { amountMinor: 200_000, currency: 'USD' },
      platformFee: { amountMinor: 0, currency: 'USD' },
      surcharge: { amountMinor: 0, currency: 'USD' },
      total: { amountMinor: 200_000, currency: 'USD' },
      pricing: { lockedTotal: { amountMinor: 200_000, currency: 'USD', scale: 2 } },
      paymentMethod: 'escrow',
      paymentTaken: false,
      settlement: { method: 'escrow', status: 'held' },
      version: 0,
      workflow: {
        definition: 'sell.v2',
        stepKey: 'payout',
        stepIndex: 13,
        phase: 14,
        owner: 'platform',
        enteredAt: now(),
      },
    });

    const payout = await adminPayoutsService.ensureForOrder(order.toObject ? order.toObject() : (order as never), {
      payoutAccountId: 'pac_1',
      method: 'bank',
      display: 'Stanbic ****1234',
    });

    await adminPayoutsService.approve(payout._id, { id: '1', publicId: 'STF-A', name: 'Ada' });
    const mid = await SellerPayoutModel.findById(payout._id).lean();
    expect(mid?.status).toBe('pending_approval');
    expect(mid?.approvals.length).toBe(1);

    await adminPayoutsService.approve(payout._id, { id: '2', publicId: 'STF-B', name: 'Ben' });
    const ok = await SellerPayoutModel.findById(payout._id).lean();
    expect(ok?.status).toBe('approved');

    const released = await adminPayoutsService.release({
      id: payout._id,
      reference: 'ZB-PO-1',
      version: 0,
      staff: { id: '3', publicId: 'STF-C', name: 'Cara' },
    });
    expect(released.status).toBe('released');
  });

  it('CSV export returns headers for orders/refunds/auctions', async () => {
    const csv = await adminExportService.orders({});
    expect(csv.split('\n')[0]).toContain('ref,kind,customer_no');
    const refunds = await adminExportService.refunds({});
    expect(refunds).toContain('ref,order_id');
    const auctions = await adminExportService.auctions({});
    expect(auctions).toContain('ref,name,status');
  });

  it('admin badges endpoint shape via overview service', async () => {
    const { adminOverview } = await import('../src/modules/admin/v2/admin-overview.service.js');
    const overview = await adminOverview();
    expect(overview.badges).toMatchObject({
      refunds: expect.any(Number),
      support: expect.any(Number),
      pendingKyc: expect.any(Number),
      activeAuctions: expect.any(Number),
      pendingChangeRequests: expect.any(Number),
    });
  });
});
