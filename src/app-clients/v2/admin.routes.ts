import { Router } from 'express';
import { z } from 'zod';
import { createSignedUrl } from '../../common/storage/signed-url.js';
import { validate } from '../../common/middleware/validate.js';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { FileModel } from '../../models/file.model.js';
import { UserModel } from '../../models/user.model.js';
import { OrderModel } from '../../models/order.model.js';
import {
  attachStaffCsrf,
  createAdminAuthRouter,
  getStaffContext,
  requireCsrf,
  requireStaff,
} from '../../modules/auth/index.js';
import { adminV2OrdersService } from '../../modules/admin/v2/admin-orders.service.js';
import {
  assignTicket,
  createStaffTicket,
  downloadDocument,
  holdInventory,
  removePartner,
  replyToTicket,
  retryNotification,
  savePartner,
  sendManualNotification,
  setOrderHold,
  setTicketStatus,
  updateShipment,
  uploadDocument,
} from '../../modules/admin/v2/admin-desk.service.js';
import {
  buildAdminConsole,
  createConsoleCustomer,
  createConsoleLot,
  deleteConsoleAuction,
  deleteConsoleLot,
  deleteConsoleTemplate,
  inviteConsoleAdmin,
  issueConsoleInvoice,
  reinstateConsoleCustomer,
  saveConsoleSettings,
  saveConsoleTemplate,
  updateConsoleCustomer,
  updateConsoleLot,
} from '../../modules/admin/v2/admin-console.service.js';
import { bulkDeleteConsoleLots } from '../../modules/admin/v2/admin-lot-bulk.service.js';
import { adminOverview } from '../../modules/admin/v2/admin-overview.service.js';
import { getKycView } from '../../modules/kyc/kyc.service.js';
import { decideSubmission } from '../../modules/kyc/kyc.review.js';
import { requireAction, effectiveActions, staffHasAction, STAFF_ACTIONS } from '../../modules/staff/actions.js';
import { unprocessable } from '../../common/errors/app-error.js';
import { syncCatalogFromCsv } from '../../modules/catalog/sheet-sync.js';
import {
  catalogueTree,
  createCategory,
  createMineral,
  createSubcategory,
  deleteCategory,
  deleteMineral,
  deleteSubcategory,
  updateCategory,
  updateMineral,
  updateSubcategory,
} from '../../modules/admin/v2/admin-catalogue.service.js';
import {
  addLotMedia,
  adjustLotStock,
  downloadLotMedia,
  listLotMedia,
  removeLotMedia,
  updateLotMedia,
} from '../../modules/admin/v2/admin-lots.service.js';
import {
  consoleRoleKey,
  createRole,
  deleteAdmin,
  deleteRole,
  listRoles,
  setAdminDisabled,
  updateAdmin,
  updateRole,
} from '../../modules/admin/v2/admin-access.service.js';
import type { ReviewDecision } from '../../modules/kyc/kyc.review.js';
import { PaymentModel } from '../../models/workflow.model.js';
import { v2PaymentsService } from '../../modules/orders/v2.payments.service.js';
import { loadOrderByRef } from '../../modules/orders/v2.order-helpers.js';
import { catalogService } from '../../modules/catalog/catalog.service.js';
import { requireAdminV2Client, requireV2Client } from './client.middleware.js';
import { idempotencyKey, requireKeyOrThrow } from '../../common/middleware/idempotency-key.js';
import { auctionsService } from '../../modules/auctions/auctions.service.js';
import { v2RefundsService } from '../../modules/refunds/v2.refunds.service.js';
import { adminPayoutsService } from '../../modules/admin/v2/admin-payouts.service.js';
import { adminExportService } from '../../modules/admin/v2/admin-export.service.js';
import { v2VariationService } from '../../modules/orders/v2.variation.service.js';
import { v2ChangesService } from '../../modules/orders/v2.changes.service.js';
import { v2NegotiationService } from '../../modules/orders/v2.negotiation.service.js';
import { v2DocumentsService } from '../../modules/documents/v2.documents.service.js';
import { v2OrdersService } from '../../modules/orders/v2.orders.service.js';
import { AuctionModel } from '../../models/auction.model.js';
import { SellerPayoutModel, RefundModel } from '../../models/workflow.model.js';
import { SupportTicketModel } from '../../models/support.model.js';

/** The acting staff member in the shape the admin services record on audit rows. */
function staffActor(staff: { id: string; name: string; publicId?: string }) {
  return { id: staff.id, name: staff.name, publicId: staff.publicId };
}

export function createV2AdminRouter(): Router {
  const r = Router();
  // An <img> or a new tab cannot send X-Client. The session cookie is still required below.
  r.use((req, _res, next) => {
    if (req.method === 'GET' && /\/files\/[^/]+\/content$/.test(req.path) && !req.header('x-client')) {
      req.headers['x-client'] = 'admin';
    }
    next();
  });
  r.use(requireV2Client, requireAdminV2Client);

  r.get('/health', (_req, res) => res.json({ status: 'ok', api: 'v2/admin' }));

  // Auth (reuse /admin/v1 handlers under /v2/admin)
  r.use(createAdminAuthRouter());

  // Authenticated surface
  r.use(requireStaff, attachStaffCsrf);

  r.get('/_meta', requireAction('ops'), (_req, res) => {
    res.json({
      version: 2,
      surface: 'admin',
      modules: [
        'auth', 'overview', 'orders', 'customers', 'kyc', 'payments', 'catalogue', 'files',
        'auctions', 'refunds', 'payouts', 'exports', 'documents', 'negotiations',
        'catalogue-hierarchy', 'lot-media', 'stock', 'admins', 'roles',
      ],
      actions: STAFF_ACTIONS,
    });
  });

  r.get('/overview', asyncHandler(async (_req, res) => {
    res.json(await adminOverview());
  }));

  r.get('/console', asyncHandler(async (req, res) => {
    const q = req.query as { page?: string; pageSize?: string };
    res.json(await buildAdminConsole({ page: Number(q.page ?? 1), pageSize: Number(q.pageSize ?? 50) }));
  }));

  r.get('/search', validate({ query: z.object({ q: z.string().min(2) }) }), asyncHandler(async (req, res) => {
    const q = String((req.query as { q: string }).q);
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const [orders, customers, products] = await Promise.all([
      OrderModel.find({ deletedAt: { $exists: false }, $or: [{ reference: re }, { customerNo: re }] }).limit(5).lean(),
      UserModel.find({ $or: [{ 'profile.fullName': re }, { email: re }, { customerNo: re }, { phone: re }] }).limit(5).lean(),
      (await import('../../models/catalog.model.js')).ProductModel.find({ $or: [{ name: re }, { reference: re }] }).limit(5).lean(),
    ]);
    res.json({
      orders: orders.map((o) => ({ ref: o.reference, kind: o.side })),
      customers: customers.map((c) => ({
        id: String(c._id),
        name: (c as { profile?: { fullName?: string } }).profile?.fullName,
        no: (c as { customerNo?: string }).customerNo,
      })),
      products: products.map((p) => ({ ref: p.reference, name: p.name })),
      refunds: [],
      threads: [],
    });
  }));

  r.get('/files/:fileId/url', asyncHandler(async (req, res) => {
    const file = await FileModel.findById(String(req.params.fileId)).lean();
    if (!file) {
      res.status(404).json({ code: 'file/not-found', message: 'File not found' });
      return;
    }
    const signed = createSignedUrl('file', file._id, 300);
    res.json({ url: signed.url, expiresAt: signed.expiresAt.toISOString() });
  }));

  // Inline bytes for a private file. KYC captures require the kyc action; other staff get 403.
  r.get('/files/:fileId/content', asyncHandler(async (req, res) => {
    const fileId = String(req.params.fileId);
    const { openAdminFile } = await import('../../modules/admin/v2/admin-files.service.js');
    const opened = await openAdminFile(fileId);
    if (!opened) {
      res.status(404).json({ code: 'file/not-found', message: 'File not found' });
      return;
    }
    if (opened.kyc) {
      // Await the gate here. asyncHandler forwards to the next route when this function
      // returns before a response has started, which would 404 the file.
      await new Promise<void>((resolve, reject) => {
        requireAction('kyc')(req, res, (err) => (err ? reject(err) : resolve()));
      });
    }
    res.setHeader('Content-Type', opened.contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(opened.filename)}"`);
    if (opened.bytes > 0) res.setHeader('Content-Length', String(opened.bytes));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    await new Promise<void>((resolve, reject) => {
      opened.stream.on('error', reject);
      res.on('finish', resolve);
      res.on('error', reject);
      opened.stream.pipe(res);
    });
  }));

  // ---- Orders ----
  r.get('/orders', asyncHandler(async (req, res) => {
    const q = req.query as Record<string, string>;
    res.json(await adminV2OrdersService.list({
      kind: q.kind,
      queue: q.queue,
      step: q.step,
      customerNo: q.customerNo,
      q: q.q,
      page: q.page ? Number(q.page) : 1,
      pageSize: q.pageSize ? Number(q.pageSize) : 25,
    }));
  }));

  r.get('/orders/:ref', asyncHandler(async (req, res) => {
    res.json(await adminV2OrdersService.detail(String(req.params.ref)));
  }));

  r.post(
    '/orders/:ref/steps/:stepKey',
    requireCsrf,
    validate({
      body: z.object({
        version: z.number().int(),
        data: z.record(z.unknown()).default({}),
        note: z.string().max(2000).optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const { staff } = getStaffContext(req);
      const stepKey = String(req.params.stepKey);
      const action =
        stepKey === 'quote' || stepKey === 'confirmed' || stepKey === 'contractMb'
          ? 'trading'
          : stepKey === 'payOk' || stepKey === 'payout'
            ? 'finance'
            : stepKey === 'schedule' || stepKey === 'inspect' || stepKey === 'sgs'
              ? 'inspection'
              : stepKey === 'assigned' || stepKey === 'picked' || stepKey === 'transit' || stepKey === 'delivered' || stepKey === 'ship'
                ? 'logistics'
                : 'ops';
      // Inline action check without blocking route registration order
      await new Promise<void>((resolve, reject) => {
        requireAction(action)(req, res, (err) => (err ? reject(err) : resolve()));
      });
      const body = req.body as { version: number; data: Record<string, unknown>; note?: string };
      const updated = await adminV2OrdersService.completeStep({
        ref: String(req.params.ref),
        stepKey,
        version: body.version,
        data: body.data ?? {},
        note: body.note,
        staff: { id: staff.id, name: staff.name, role: staff.roleKey ?? staff.role?.name },
      });
      res.json(updated);
    }),
  );

  r.post(
    '/orders/:ref/reject',
    requireCsrf,
    requireAction('ops'),
    validate({ body: z.object({ version: z.number().int(), reason: z.string().min(5).max(2000) }) }),
    asyncHandler(async (req, res) => {
      const { staff } = getStaffContext(req);
      const body = req.body as { version: number; reason: string };
      res.json(await adminV2OrdersService.reject(String(req.params.ref), body.version, body.reason, {
        id: staff.id, name: staff.name,
      }));
    }),
  );

  const inspectionStaff = (staff: { id: string; name: string; roleKey?: string; role?: { name?: string } }) => ({
    id: staff.id, name: staff.name, role: staff.roleKey ?? staff.role?.name,
  });
  r.post('/orders/:ref/inspection-report', requireCsrf, requireAction('inspection', 'ops'), validate({
    body: z.object({
      certificateNo: z.string().trim().min(1).max(80),
      grade: z.string().trim().max(80).optional(),
      net: z.object({ measure: z.string().optional(), unit: z.string().optional(), base: z.number().optional(), value: z.number().optional() }),
      result: z.string().trim().min(1).max(80),
      remarks: z.string().trim().max(2000).optional(),
      fileId: z.string().trim().max(80).optional(),
    }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.json(await adminV2OrdersService.reviseInspectionReport(String(req.params.ref), req.body, inspectionStaff(staff)));
  }));
  r.post('/orders/:ref/inspection/reinspect', requireCsrf, requireAction('inspection', 'ops'), validate({
    body: z.object({
      weight: z.object({ measure: z.string().optional(), unit: z.string().optional(), base: z.number().optional(), value: z.number().optional() }).optional(),
      seals: z.string().trim().max(160).optional(),
      result: z.string().trim().min(1).max(160),
      notes: z.string().trim().max(2000).optional(),
      inspector: z.string().trim().max(160).optional(),
      agency: z.string().trim().max(160).optional(),
    }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.json(await adminV2OrdersService.reinspect(String(req.params.ref), req.body, inspectionStaff(staff)));
  }));
  r.post('/orders/:ref/inspection/request-correction', requireCsrf, requireAction('inspection', 'ops'), validate({
    body: z.object({ note: z.string().trim().max(2000).optional() }).optional(),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    const note = (req.body as { note?: string } | undefined)?.note;
    res.json(await adminV2OrdersService.requestCorrectedReport(String(req.params.ref), note, inspectionStaff(staff)));
  }));

  // ---- Customers ----
  r.get('/customers', requireAction('kyc'), asyncHandler(async (req, res) => {
    const q = String((req.query as { q?: string }).q ?? '');
    const filter = q
      ? { $or: [{ 'profile.fullName': new RegExp(q, 'i') }, { email: new RegExp(q, 'i') }, { phone: new RegExp(q, 'i') }, { customerNo: new RegExp(q, 'i') }] }
      : {};
    const rows = await UserModel.find(filter).sort({ createdAt: -1 }).limit(50).lean();
    res.json({
      items: rows.map((u) => ({
        id: String(u._id),
        customerNo: (u as { customerNo?: string }).customerNo,
        name: (u as { profile?: { fullName?: string } }).profile?.fullName,
        email: (u as { email?: string }).email,
        phone: (u as { phone?: string }).phone,
        kycStatus: (u as { kycStatus?: string }).kycStatus,
        accountStatus: (u as { accountStatus?: string }).accountStatus,
      })),
    });
  }));

  r.get('/customers/:id', requireAction('kyc'), asyncHandler(async (req, res) => {
    const u = await UserModel.findById(String(req.params.id)).lean();
    if (!u) {
      res.status(404).json({ code: 'customer/not-found', message: 'Customer not found' });
      return;
    }
    res.json(u);
  }));

  r.post(
    '/customers/:id/suspend',
    requireCsrf,
    requireAction('suspend'),
    validate({ body: z.object({ reason: z.string().min(5).max(500) }) }),
    asyncHandler(async (req, res) => {
      const { staff } = getStaffContext(req);
      await UserModel.updateOne(
        { _id: String(req.params.id) },
        {
          $set: {
            accountStatus: 'suspended',
            suspension: { reason: (req.body as { reason: string }).reason, at: new Date(), by: { kind: 'staff', id: staff.id, name: staff.name } },
          },
        },
      );
      res.json({ ok: true });
    }),
  );

  // ---- KYC ----
  r.get('/kyc', requireAction('kyc'), asyncHandler(async (_req, res) => {
    const { KycSubmissionModel } = await import('../../modules/kyc/kyc.model.js');
    const rows = await KycSubmissionModel.find({ status: { $in: ['pending', 'in_review'] } })
      .sort({ submittedAt: 1 })
      .limit(100)
      .lean();
    res.json({ items: rows });
  }));

  r.get('/kyc/:userId', requireAction('kyc'), asyncHandler(async (req, res) => {
    res.json(await getKycView(String(req.params.userId)));
  }));

  r.post(
    '/kyc/:submissionId/decide',
    requireCsrf,
    requireAction('kyc'),
    validate({
      body: z.object({
        decision: z.enum(['verified', 'rejected', 'resubmission_required']),
        reason: z.string().optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const { staff } = getStaffContext(req);
      const body = req.body as { decision: 'verified' | 'rejected' | 'resubmission_required'; reason?: string };
      let decision: ReviewDecision;
      if (body.decision === 'verified') decision = { type: 'approve' };
      else if (body.decision === 'rejected') {
        decision = {
          type: 'reject',
          rejection: { code: 'kyc/rejected', reason: body.reason ?? 'Rejected', retryAllowed: false },
        };
      } else {
        decision = {
          type: 'request_resubmission',
          rejection: { code: 'kyc/resubmission', reason: body.reason ?? 'Please resubmit' },
        };
      }
      const result = await decideSubmission({
        submission: String(req.params.submissionId),
        staffPublicId: staff.publicId ?? staff.id,
        decision,
      });
      res.json(result);
    }),
  );

  // ---- Payments ----
  r.get('/payments', requireAction('finance'), asyncHandler(async (_req, res) => {
    const rows = await PaymentModel.find({ status: { $in: ['submitted', 'confirming'] } })
      .sort({ createdAt: 1 })
      .limit(100)
      .lean();
    res.json({ items: rows });
  }));

  r.post(
    '/payments/:orderRef/confirm',
    requireCsrf,
    requireAction('finance'),
    validate({ body: z.object({ version: z.number().int(), confirmedRef: z.string().optional() }) }),
    asyncHandler(async (req, res) => {
      const { staff } = getStaffContext(req);
      const order = await loadOrderByRef(String(req.params.orderRef));
      const body = req.body as { version: number; confirmedRef?: string };
      const updated = await v2PaymentsService.confirm(order, { id: staff.id, name: staff.name }, body.version, body.confirmedRef);
      res.json(updated);
    }),
  );

  r.post(
    '/payments/:orderRef/reject',
    requireCsrf,
    requireAction('finance'),
    validate({ body: z.object({ version: z.number().int(), reason: z.string().min(5) }) }),
    asyncHandler(async (req, res) => {
      const { staff } = getStaffContext(req);
      const order = await loadOrderByRef(String(req.params.orderRef));
      const body = req.body as { version: number; reason: string };
      res.json(await v2PaymentsService.reject(order, { id: staff.id, name: staff.name }, body.version, body.reason));
    }),
  );

  // ---- Catalogue (read) ----
  r.get('/catalogue/categories', requireAction('catalogue'), asyncHandler(async (_req, res) => {
    res.json({ items: await catalogService.hierarchy() });
  }));

  r.get('/me/actions', asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.json({
      actions: effectiveActions(staff),
      roleKey: consoleRoleKey(staff),
    });
  }));

  // ---- Badges (rich counts) ----
  r.get('/badges', asyncHandler(async (_req, res) => {
    const [
      pendingKyc,
      pendingOrders,
      pendingQuotations,
      pendingContracts,
      pendingPayments,
      pendingInspections,
      pendingRefunds,
      pendingPayouts,
      activeAuctions,
      pendingChanges,
      pendingSupport,
    ] = await Promise.all([
      (await import('../../modules/kyc/kyc.model.js')).KycSubmissionModel.countDocuments({ status: { $in: ['pending', 'in_review'] } }),
      OrderModel.countDocuments({ status: { $nin: ['completed', 'cancelled', 'rejected'] }, 'workflow.owner': { $ne: 'customer' } }),
      OrderModel.countDocuments({ 'workflow.stepKey': { $in: ['quote', 'quoteOk'] }, status: { $nin: ['cancelled', 'rejected'] } }),
      OrderModel.countDocuments({ 'workflow.stepKey': { $in: ['contract', 'contractMb'] }, status: { $nin: ['cancelled', 'rejected'] } }),
      PaymentModel.countDocuments({ status: { $in: ['submitted', 'confirming'] } }),
      OrderModel.countDocuments({ 'workflow.stepKey': { $in: ['schedule', 'inspect', 'sgs'] }, status: { $nin: ['cancelled', 'rejected'] } }),
      RefundModel.countDocuments({ status: { $in: ['requested', 'review', 'approved', 'processing'] } }),
      SellerPayoutModel.countDocuments({ status: { $in: ['pending_approval', 'approved'] } }),
      AuctionModel.countDocuments({ status: 'live' }),
      OrderModel.countDocuments({ 'hold.type': 'changes' }),
      SupportTicketModel.countDocuments({ status: { $nin: ['resolved', 'closed'] } }),
    ]);
    res.json({
      pendingKyc,
      pendingOrders,
      pendingQuotations,
      pendingContracts,
      pendingPayments,
      pendingInspections,
      pendingRefunds,
      pendingPayouts,
      activeAuctions,
      pendingChangeRequests: pendingChanges,
      pendingSupportTickets: pendingSupport,
    });
  }));

  // ---- CSV exports ----
  const sendCsv = (res: import('express').Response, filename: string, body: string) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(body);
  };

  r.get('/orders/export', requireAction('ops'), asyncHandler(async (req, res) => {
    sendCsv(res, 'orders.csv', await adminExportService.orders(req.query as { from?: string; to?: string; kind?: string; q?: string }));
  }));
  r.get('/customers/export', requireAction('kyc'), asyncHandler(async (req, res) => {
    sendCsv(res, 'customers.csv', await adminExportService.customers(req.query as { from?: string; to?: string; search?: string }));
  }));
  r.get('/payments/export', requireAction('finance'), asyncHandler(async (req, res) => {
    sendCsv(res, 'payments.csv', await adminExportService.payments(req.query as { from?: string; to?: string }));
  }));
  r.get('/refunds/export', requireAction('finance'), asyncHandler(async (req, res) => {
    sendCsv(res, 'refunds.csv', await adminExportService.refunds(req.query as { from?: string; to?: string; status?: string }));
  }));
  r.get('/auctions/export', requireAction('auction'), asyncHandler(async (req, res) => {
    sendCsv(res, 'auctions.csv', await adminExportService.auctions(req.query as { from?: string; to?: string; status?: string }));
  }));
  r.get('/kyc/export', requireAction('kyc'), asyncHandler(async (req, res) => {
    sendCsv(res, 'kyc.csv', await adminExportService.kyc(req.query as { from?: string; to?: string; status?: string }));
  }));
  r.get('/payouts/export', requireAction('finance'), asyncHandler(async (req, res) => {
    sendCsv(res, 'payouts.csv', await adminExportService.payouts(req.query as { from?: string; to?: string; status?: string }));
  }));

  // ---- Create order on behalf of customer ----
  r.post(
    '/orders',
    requireCsrf,
    requireAction('ops'),
    validate({
      body: z.object({
        customerId: z.string().min(1),
        kind: z.enum(['buy', 'sell']),
        items: z.array(z.object({
          productRef: z.string(),
          qty: z.object({ value: z.union([z.string(), z.number()]), unit: z.enum(['g', 'kg', 't', 'ct']) }),
        })).optional(),
        delivery: z.object({
          org: z.string(),
          street: z.string(),
          city: z.string(),
          country: z.string(),
          contact: z.string(),
          mobile: z.string(),
          region: z.string().optional(),
        }).optional(),
        sell: z.object({
          mineral: z.string(),
          qty: z.object({ value: z.union([z.string(), z.number()]), unit: z.enum(['g', 'kg', 't', 'ct']) }),
          grade: z.string(),
          form: z.string().max(60),
          details: z.string().min(10),
          photoFileIds: z.array(z.string()).default([]),
          /** Photos received outside the app, entered by staff. At least 3 files or 3 received. */
          photosReceived: z.number().int().min(0).max(100).optional(),
          documentFileIds: z.array(z.string()).optional(),
          name: z.string().optional(),
        }).refine((s) => Math.max(s.photoFileIds.length, s.photosReceived ?? 0) >= 3, {
          message: 'At least 3 photos are required',
          path: ['photosReceived'],
        }).optional(),
        note: z.string().trim().max(1000).optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const { staff } = getStaffContext(req);
      const body = req.body as {
        note?: string;
        customerId: string;
        kind: 'buy' | 'sell';
        items?: { productRef: string; qty: { value: string | number; unit: 'g' | 'kg' | 't' | 'ct' } }[];
        delivery?: {
          org: string; street: string; city: string; country: string; contact: string; mobile: string; region?: string;
        };
        sell?: {
          mineral: string; qty: { value: string | number; unit: 'g' | 'kg' | 't' | 'ct' }; grade: string;
          form: string; details: string; photoFileIds: string[]; photosReceived?: number; documentFileIds?: string[]; name?: string;
        };
      };
      const customer = await UserModel.findById(body.customerId).lean();
      if (!customer) {
        res.status(404).json({ code: 'customer/not-found', message: 'Customer not found' });
        return;
      }
      let created;
      if (body.kind === 'buy') {
        if (!body.items?.length || !body.delivery) {
          res.status(422).json({ code: 'validation/failed', message: 'items and delivery required for buy' });
          return;
        }
        created = await v2OrdersService.createBuy({
          userId: String(customer._id),
          items: body.items,
          delivery: body.delivery,
        });
      } else {
        if (!body.sell) {
          res.status(422).json({ code: 'validation/failed', message: 'sell payload required' });
          return;
        }
        created = await v2OrdersService.createSell({ userId: String(customer._id), sell: body.sell });
      }
      await OrderModel.updateOne(
        { reference: created.reference },
        {
          $set: {
            createdByStaff: { kind: 'staff', id: staff.id, name: staff.name },
            source: { kind: 'admin', refId: staff.id },
          },
          $push: {
            timeline: {
              stepKey: 'created',
              label: 'Created by admin on behalf of customer',
              actor: { kind: 'staff', id: staff.id, name: staff.name },
              ...(body.note ? { note: body.note } : {}),
              at: new Date(),
            },
          },
        },
      );
      res.status(201).json(created);
    }),
  );

  // ---- Order negotiation / variation / changes ----
  r.get('/orders/:ref/negotiation', requireAction('trading'), asyncHandler(async (req, res) => {
    res.json(await v2NegotiationService.get(String(req.params.ref)));
  }));
  r.post(
    '/orders/:ref/negotiation',
    requireCsrf,
    requireAction('trading'),
    validate({ body: z.object({ text: z.string().max(2000).optional(), offerMinor: z.number().int().positive().optional() }) }),
    asyncHandler(async (req, res) => {
      const { staff } = getStaffContext(req);
      const b = req.body as { text?: string; offerMinor?: number };
      res.json(await v2NegotiationService.postStaff({
        ref: String(req.params.ref),
        text: b.text,
        offerMinor: b.offerMinor,
        staff: { id: staff.id, name: staff.name },
      }));
    }),
  );

  r.post(
    '/orders/:ref/price-variations',
    requireCsrf,
    requireAction('trading'),
    validate({
      body: z.object({
        newTotalMinor: z.number().int().positive(),
        reason: z.enum(['qty', 'grade', 'both', 'market', 'other']),
        note: z.string().min(5).max(1000),
        version: z.number().int(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const { staff } = getStaffContext(req);
      const b = req.body as { newTotalMinor: number; reason: 'qty' | 'grade' | 'both' | 'market' | 'other'; note: string; version: number };
      res.status(201).json(await v2VariationService.propose({
        ref: String(req.params.ref),
        ...b,
        staff: { id: staff.id, name: staff.name },
      }));
    }),
  );

  r.post(
    '/orders/:ref/changes',
    requireCsrf,
    requireAction('ops'),
    validate({
      body: z.object({
        scope: z.enum(['submission', 'seller_form']),
        note: z.string().min(5).max(2000),
        flaggedFileIds: z.array(z.string()).optional(),
        version: z.number().int(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const { staff } = getStaffContext(req);
      const b = req.body as { scope: 'submission' | 'seller_form'; note: string; flaggedFileIds?: string[]; version: number };
      res.json(await v2ChangesService.requestChanges({
        ref: String(req.params.ref),
        ...b,
        staff: { id: staff.id, name: staff.name },
      }));
    }),
  );

  // ---- Auctions admin ----
  r.get('/auctions', requireAction('auction'), asyncHandler(async (req, res) => {
    const status = (req.query as { status?: string }).status;
    const states = status ? [status as 'live'] : ['live', 'upcoming', 'ended'];
    const { rows, total } = await auctionsService.list({ states: states as ('live' | 'upcoming' | 'ended')[], skip: 0, limit: 100 });
    res.json({ items: rows, total });
  }));

  r.post(
    '/auctions',
    requireCsrf,
    requireAction('auction'),
    validate({
      body: z.object({
        name: z.string().min(2),
        quantityGrams: z.number().positive(),
        currency: z.string().default('USD'),
        startingBidMinor: z.number().int().positive(),
        stepMinor: z.number().int().positive(),
        opensAt: z.string(),
        closesAt: z.string(),
        productId: z.string().optional(),
        reserveMinor: z.number().int().optional(),
        assured: z.boolean().optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const b = req.body as {
        name: string; quantityGrams: number; currency: string; startingBidMinor: number; stepMinor: number;
        opensAt: string; closesAt: string; productId?: string; reserveMinor?: number; assured?: boolean;
      };
      const a = await auctionsService.create({
        name: b.name,
        quantityGrams: b.quantityGrams,
        currency: b.currency,
        startingBidMinor: b.startingBidMinor,
        minimumIncrementMinor: b.stepMinor,
        opensAt: new Date(b.opensAt),
        closesAt: new Date(b.closesAt),
        productId: b.productId,
        reserveMinor: b.reserveMinor,
        assured: b.assured,
        status: 'scheduled',
      });
      res.status(201).json(a);
    }),
  );

  r.post('/auctions/:id/transition', requireCsrf, requireAction('auction'), validate({
    body: z.object({
      to: z.enum(['scheduled', 'live', 'paused', 'ended', 'cancelled']),
      /** Shown to bidders. Stored when cancelling. */
      reason: z.string().trim().min(3).max(500).optional(),
    }),
  }), asyncHandler(async (req, res) => {
    const b = req.body as { to: 'scheduled' | 'live' | 'paused' | 'ended' | 'cancelled'; reason?: string };
    const updated = await auctionsService.transition(String(req.params.id), b.to);
    if (b.to === 'cancelled' && b.reason) {
      await AuctionModel.updateOne({ _id: updated._id }, { $set: { cancelReason: b.reason } });
      res.json({ ...updated, cancelReason: b.reason });
      return;
    }
    res.json(updated);
  }));

  r.post('/auctions/:id/finalize', requireCsrf, requireAction('auction'), asyncHandler(async (req, res) => {
    res.json(await auctionsService.finalize(String(req.params.id)));
  }));

  r.post('/auctions/:id/extend', requireCsrf, requireAction('auction'), validate({
    body: z.object({ hours: z.number().positive().max(168).default(1) }),
  }), asyncHandler(async (req, res) => {
    const hours = Number((req.body as { hours?: number }).hours ?? 1);
    res.json(await auctionsService.extend(String(req.params.id), hours));
  }));

  r.post('/auctions/:ref/order', requireCsrf, requireAction('auction'), asyncHandler(async (req, res) => {
    const a = await auctionsService.get(String(req.params.ref)).catch(async () => {
      const byRef = await AuctionModel.findOne({ reference: String(req.params.ref) }).lean();
      if (!byRef) throw new Error('not found');
      return auctionsService.get(byRef._id);
    });
    const finalized = await auctionsService.ensureFinalized(a);
    if (finalized.outcome?.settlementOrderId) {
      const order = await OrderModel.findById(finalized.outcome.settlementOrderId).lean();
      res.json({ orderRef: order?.reference ?? finalized.outcome.settlementOrderId });
      return;
    }
    const again = await auctionsService.finalize(a._id);
    const order = again?.outcome?.settlementOrderId
      ? await OrderModel.findById(again.outcome.settlementOrderId).lean()
      : null;
    res.status(201).json({ orderRef: order?.reference ?? again?.outcome?.settlementOrderId });
  }));

  // ---- Refunds admin ----
  r.get('/refunds', requireAction('finance'), asyncHandler(async (req, res) => {
    const q = req.query as { status?: string; q?: string };
    res.json(await v2RefundsService.adminList({ status: q.status, search: q.q }));
  }));
  r.get('/refunds/:ref', requireAction('finance'), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    const unmask = staffHasAction(staff, 'finance');
    res.json(await v2RefundsService.adminGet(String(req.params.ref), unmask));
  }));
  r.post(
    '/refunds',
    requireCsrf,
    requireAction('finance'),
    idempotencyKey(true),
    validate({
      body: z.object({
        orderRef: z.string(),
        type: z.enum(['full', 'partial']),
        amountMinor: z.number().int().positive().optional(),
        reason: z.string(),
        note: z.string().min(10),
        destination: z.object({ method: z.enum(['original', 'bank', 'upi', 'btc']) }).passthrough(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const { staff } = getStaffContext(req);
      const b = req.body as {
        orderRef: string; type: 'full' | 'partial'; amountMinor?: number; reason: string; note: string;
        destination: { method: 'original' | 'bank' | 'upi' | 'btc' };
      };
      const order = await loadOrderByRef(b.orderRef);
      const result = await v2RefundsService.request({
        userId: order.userId,
        ref: order.reference,
        type: b.type,
        amountMinor: b.amountMinor,
        reason: b.reason,
        note: b.note,
        destination: b.destination,
        agree: true,
        idempotencyKey: requireKeyOrThrow(req),
        actor: { kind: 'staff', id: staff.id, name: staff.name },
      });
      res.status(201).json(result.refund);
    }),
  );
  r.patch('/refunds/:ref', requireCsrf, requireAction('finance'), validate({
    body: z.object({ amountMinor: z.number().int().positive().optional(), reason: z.string().optional(), note: z.string().optional() }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.json(await v2RefundsService.patch(String(req.params.ref), req.body, { id: staff.id, name: staff.name }));
  }));

  for (const action of ['review', 'approve', 'decline', 'processing', 'complete'] as const) {
    r.post(
      `/refunds/:ref/${action}`,
      requireCsrf,
      requireAction('finance'),
      validate({
        body: z.object({
          reason: z.string().optional(),
          bankRef: z.string().optional(),
          version: z.number().int().optional(),
        }),
      }),
      asyncHandler(async (req, res) => {
        const { staff } = getStaffContext(req);
        const b = req.body as { reason?: string; bankRef?: string; version?: number };
        res.json(await v2RefundsService.transition({
          ref: String(req.params.ref),
          action,
          staff: { id: staff.id, publicId: staff.publicId, name: staff.name },
          reason: b.reason,
          bankRef: b.bankRef,
          version: b.version,
        }));
      }),
    );
  }

  // ---- Payouts ----
  r.get('/payouts', requireAction('finance'), asyncHandler(async (req, res) => {
    res.json(await adminPayoutsService.list((req.query as { status?: string }).status));
  }));
  r.post('/payouts/:id/approve', requireCsrf, requireAction('finance'), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.json(await adminPayoutsService.approve(String(req.params.id), {
      id: staff.id, publicId: staff.publicId, name: staff.name,
    }));
  }));
  r.post(
    '/payouts/:id/release',
    requireCsrf,
    requireAction('finance'),
    idempotencyKey(true),
    validate({ body: z.object({ reference: z.string().min(3), version: z.number().int() }) }),
    asyncHandler(async (req, res) => {
      requireKeyOrThrow(req);
      const { staff } = getStaffContext(req);
      const b = req.body as { reference: string; version: number };
      res.json(await adminPayoutsService.release({
        id: String(req.params.id),
        reference: b.reference,
        version: b.version,
        staff: { id: staff.id, publicId: staff.publicId, name: staff.name },
      }));
    }),
  );
  r.post(
    '/orders/:ref/payouts',
    requireCsrf,
    requireAction('finance'),
    validate({
      body: z.object({
        payoutAccountId: z.string(),
        method: z.enum(['bank', 'upi', 'mobile_money', 'btc']),
        display: z.string().min(2),
      }),
    }),
    asyncHandler(async (req, res) => {
      const b = req.body as { payoutAccountId: string; method: 'bank' | 'upi' | 'mobile_money' | 'btc'; display: string };
      const p = await adminPayoutsService.createFromOrderStep(String(req.params.ref), b);
      res.status(201).json(p);
    }),
  );

  // ---- Documents register ----
  r.get('/documents', requireAction('ops'), asyncHandler(async (req, res) => {
    const q = req.query as { status?: string; type?: string; q?: string };
    res.json(await v2DocumentsService.adminList({ status: q.status, type: q.type, search: q.q }));
  }));
  r.get('/documents/:number', requireAction('ops'), asyncHandler(async (req, res) => {
    const result = await v2DocumentsService.getByNumber({ number: String(req.params.number), staff: true, format: 'json' });
    res.json(result.kind === 'json' ? result.document : result);
  }));
  r.post('/documents/:number/reissue', requireCsrf, requireAction('ops', 'settings'), validate({
    body: z.object({ reason: z.string().min(3) }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.json(await v2DocumentsService.reissue(String(req.params.number), (req.body as { reason: string }).reason, {
      kind: 'staff', id: staff.id, name: staff.name,
    }));
  }));
  r.post(
    '/customers',
    requireCsrf,
    requireAction('ops'),
    validate({
      body: z.object({
        fullName: z.string().min(2).max(160),
        email: z.string().email().optional(),
        phone: z.string().min(7).max(20).optional(),
        countryCode: z.string().length(2).optional(),
        businessName: z.string().max(160).optional(),
        role: z.enum(['buyer', 'seller', 'both']).optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const created = await createConsoleCustomer(req.body as {
        fullName: string; email?: string; phone?: string; countryCode?: string; businessName?: string; role?: 'buyer' | 'seller' | 'both';
      });
      res.status(201).json(created);
    }),
  );

  r.patch(
    '/customers/:id',
    requireCsrf,
    requireAction('kyc'),
    validate({
      body: z.object({
        fullName: z.string().min(2).max(160).optional(),
        businessName: z.string().max(160).optional(),
        countryCode: z.string().length(2).optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      res.json(await updateConsoleCustomer(String(req.params.id), req.body as { fullName?: string; businessName?: string; countryCode?: string }));
    }),
  );

  r.post('/customers/:id/reinstate', requireCsrf, requireAction('suspend'), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.json(await reinstateConsoleCustomer(String(req.params.id), { id: staff.id, name: staff.name }));
  }));

  r.post(
    '/catalogue/lots',
    requireCsrf,
    requireAction('catalogue'),
    validate({
      body: z.object({
        name: z.string().min(2).max(160),
        mineral: z.string().min(2).max(60),
        unit: z.enum(['g', 'kg', 't']),
        avail: z.number().nonnegative(),
        origin: z.string().min(2).max(160),
        grade: z.string().max(80).optional(),
        form: z.string().max(60).optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      res.status(201).json(await createConsoleLot(req.body as {
        name: string; mineral: string; unit: 'g' | 'kg' | 't'; avail: number; origin: string; grade?: string; form?: string;
      }));
    }),
  );

  r.patch(
    '/catalogue/lots/:ref',
    requireCsrf,
    requireAction('catalogue'),
    validate({
      body: z.object({
        name: z.string().min(2).max(160).optional(),
        grade: z.string().max(80).optional(),
        status: z.enum(['listed', 'draft', 'sold out', 'archived']).optional(),
        avail: z.number().nonnegative().optional(),
        unit: z.enum(['g', 'kg', 't']).optional(),
        minOrder: z.number().nonnegative().optional(),
        referencePrice: z.number().nonnegative().optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      res.json(await updateConsoleLot(String(req.params.ref), req.body as { name?: string; grade?: string; status?: 'listed' | 'draft' | 'sold out' | 'archived'; avail?: number; unit?: 'g' | 'kg' | 't'; minOrder?: number; referencePrice?: number }));
    }),
  );

  r.post(
    '/catalogue/lots/bulk-delete',
    requireCsrf,
    requireAction('catalogue'),
    validate({
      body: z.object({
        ids: z.array(z.string().min(1).max(80)).min(1).max(2000),
      }),
    }),
    asyncHandler(async (req, res) => {
      const { staff } = getStaffContext(req);
      res.json(await bulkDeleteConsoleLots((req.body as { ids: string[] }).ids, { id: staff.id, name: staff.name }));
    }),
  );

  r.delete('/catalogue/lots/:ref', requireCsrf, requireAction('catalogue'), asyncHandler(async (req, res) => {
    await deleteConsoleLot(String(req.params.ref));
    res.status(204).end();
  }));

  r.delete('/auctions/:id', requireCsrf, requireAction('auction'), asyncHandler(async (req, res) => {
    await deleteConsoleAuction(String(req.params.id));
    res.status(204).end();
  }));

  r.patch(
    '/settings',
    requireCsrf,
    requireAction('settings'),
    validate({ body: z.record(z.union([z.string(), z.number(), z.boolean()])) }),
    asyncHandler(async (req, res) => {
      res.json(await saveConsoleSettings(req.body as Record<string, string | number | boolean>));
    }),
  );

  r.post('/support', requireCsrf, requireAction('support'), validate({
    body: z.object({
      customerId: z.string().min(1),
      topic: z.string().max(80).optional(),
      subject: z.string().max(160).optional(),
      body: z.string().min(1).max(4000),
      relatedRef: z.string().max(80).optional(),
    }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.status(201).json(await createStaffTicket(req.body as { customerId: string; topic?: string; subject?: string; body: string; relatedRef?: string }, staff));
  }));
  r.post('/notifications', requireCsrf, requireAction('support'), validate({
    body: z.object({
      customerId: z.string().min(1),
      message: z.string().min(1).max(1000),
      channel: z.enum(['all', 'email', 'sms', 'whatsapp', 'push']).optional(),
      ref: z.string().max(80).optional(),
    }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.status(201).json(await sendManualNotification(req.body as { customerId: string; message: string; channel?: 'all'; ref?: string }, staff));
  }));
  r.post('/support/:ref/reply', requireCsrf, requireAction('support'), validate({
    body: z.object({ body: z.string().min(1).max(4000) }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.json(await replyToTicket(String(req.params.ref), (req.body as { body: string }).body, staff));
  }));
  r.post('/support/:ref/status', requireCsrf, requireAction('support'), validate({
    body: z.object({ status: z.enum(['open', 'resolved']) }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.json(await setTicketStatus(String(req.params.ref), (req.body as { status: 'open' | 'resolved' }).status, staff));
  }));
  r.post('/support/:ref/assign', requireCsrf, requireAction('support'), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.json(await assignTicket(String(req.params.ref), staff));
  }));
  r.post('/notifications/:id/retry', requireCsrf, requireAction('support'), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.json(await retryNotification(String(req.params.id), staff));
  }));
  r.post('/documents/upload', requireCsrf, requireAction('ops'), validate({
    body: z.object({
      orderRef: z.string().optional(),
      number: z.string().optional(),
      filename: z.string().min(1).max(180),
      contentType: z.string().min(3),
      contentBase64: z.string().min(8),
      type: z.string().optional(),
    }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    const b = req.body as { orderRef?: string; number?: string; filename: string; contentType: string; contentBase64: string; type?: 'consignment_note' };
    res.status(201).json(await uploadDocument({ ...b, staff }));
  }));
  r.get('/documents/:number/download', requireAction('ops'), asyncHandler(async (req, res) => {
    res.json(await downloadDocument(String(req.params.number)));
  }));
  r.post('/partners', requireCsrf, requireAction('logistics', 'inspection', 'ops'), validate({
    body: z.object({
      name: z.string().min(2).max(160),
      type: z.enum(['logistics', 'inspection', 'lab', 'inspection_agency', 'bonded_carrier']),
      regions: z.string().optional(),
      contact: z.string().optional(),
      active: z.boolean().optional(),
    }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.status(201).json(await savePartner({ ...(req.body as { name: string; type: 'logistics' }), staff }));
  }));
  r.patch('/partners/:id', requireCsrf, requireAction('logistics', 'inspection', 'ops'), validate({
    body: z.object({
      name: z.string().min(2).max(160),
      type: z.enum(['logistics', 'inspection', 'lab', 'inspection_agency', 'bonded_carrier']).optional(),
      regions: z.string().optional(),
      contact: z.string().optional(),
      active: z.boolean().optional(),
    }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    const b = req.body as { name: string; type?: 'logistics' };
    res.json(await savePartner({ partnerId: String(req.params.id), name: b.name, type: b.type ?? 'logistics', regions: (req.body as { regions?: string }).regions, contact: (req.body as { contact?: string }).contact, active: (req.body as { active?: boolean }).active, staff }));
  }));
  r.delete('/partners/:id', requireCsrf, requireAction('logistics', 'inspection', 'ops'), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.json(await removePartner(String(req.params.id), staff));
  }));
  r.patch('/shipments/:ref', requireCsrf, requireAction('logistics'), validate({
    body: z.object({
      status: z.enum(['booked', 'loaded', 'in_transit', 'discharged', 'delivered', 'delayed', 'pickup_scheduled', 'picked_up', 'received_at_vault']).optional(),
      location: z.string().max(180).optional(),
      note: z.string().max(500).optional(),
    }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.json(await updateShipment(String(req.params.ref), req.body as { status?: 'in_transit'; location?: string; note?: string }, staff));
  }));
  r.post('/catalogue/lots/:ref/hold', requireCsrf, requireAction('catalogue'), validate({
    body: z.object({ hold: z.boolean(), reason: z.string().optional() }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.json(await holdInventory(String(req.params.ref), req.body as { hold: boolean; reason?: string }, staff));
  }));
  r.post('/orders/:ref/hold', requireCsrf, requireAction('ops'), validate({
    body: z.object({
      type: z.enum(['declined', 'discrepancy', 'refund', 'changes', 'clarify']).optional(),
      reason: z.string().optional(),
      clear: z.boolean().optional(),
    }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.json(await setOrderHold(String(req.params.ref), req.body as { type?: 'changes'; reason?: string; clear?: boolean }, staff));
  }));

  r.post('/templates', requireCsrf, requireAction('settings'), validate({
    body: z.object({ id: z.string().optional(), name: z.string().min(2), body: z.string().min(5) }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    const b = req.body as { id?: string; name: string; body: string };
    res.status(b.id ? 200 : 201).json(await saveConsoleTemplate({ ...b, staff: { id: staff.id, name: staff.name } }));
  }));
  r.delete('/templates/:id', requireCsrf, requireAction('settings'), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.json(await deleteConsoleTemplate(String(req.params.id), { id: staff.id, name: staff.name }));
  }));
  r.post('/admins/invite', requireCsrf, requireAction('settings'), validate({
    body: z.object({ name: z.string().min(2), email: z.string().email(), roleKey: z.string().min(2) }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    const b = req.body as { name: string; email: string; roleKey: string };
    res.status(201).json(await inviteConsoleAdmin({ ...b, staff: { id: staff.id, name: staff.name } }));
  }));
  // ---- Admin lifecycle ----
  r.patch('/admins/:id', requireCsrf, requireAction('settings'), validate({
    body: z.object({
      name: z.string().trim().min(2).max(120).optional(),
      email: z.string().email().optional(),
      roleKey: z.string().trim().min(2).max(80).optional(),
    }).refine((b) => b.name !== undefined || b.email !== undefined || b.roleKey !== undefined, { message: 'Nothing to change' }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.json(await updateAdmin(String(req.params.id), req.body as { name?: string; email?: string; roleKey?: string }, staffActor(staff)));
  }));
  for (const [path, disabled] of [['disable', true], ['enable', false]] as const) {
    r.post(`/admins/:id/${path}`, requireCsrf, requireAction('settings'), validate({
      body: z.object({ reason: z.string().trim().max(500).optional() }),
    }), asyncHandler(async (req, res) => {
      const { staff } = getStaffContext(req);
      res.json(await setAdminDisabled(String(req.params.id), disabled, staffActor(staff), (req.body as { reason?: string }).reason));
    }));
  }
  r.delete('/admins/:id', requireCsrf, requireAction('settings'), validate({
    body: z.object({ reason: z.string().trim().max(500).optional() }).optional(),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    const reason = (req.body as { reason?: string } | undefined)?.reason ?? (req.query as { reason?: string }).reason;
    res.json(await deleteAdmin(String(req.params.id), staffActor(staff), reason));
  }));

  // ---- Roles ----
  const actionList = z.array(z.string().trim().min(1).max(40)).max(STAFF_ACTIONS.length);
  r.get('/roles', requireAction('settings'), asyncHandler(async (_req, res) => {
    res.json({ items: await listRoles() });
  }));
  r.post('/roles', requireCsrf, requireAction('settings'), validate({
    body: z.object({ label: z.string().trim().min(2).max(60), copyFrom: z.string().trim().max(80).optional(), actions: actionList.optional() }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.status(201).json(await createRole(req.body as { label: string; copyFrom?: string; actions?: string[] }, staffActor(staff)));
  }));
  r.patch('/roles/:key', requireCsrf, requireAction('settings'), validate({
    body: z.object({ label: z.string().trim().min(2).max(60).optional(), actions: actionList.optional(), reset: z.boolean().optional() })
      .refine((b) => b.label !== undefined || b.actions !== undefined || b.reset !== undefined, { message: 'Nothing to change' }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.json(await updateRole(String(req.params.key), req.body as { label?: string; actions?: string[]; reset?: boolean }, staffActor(staff)));
  }));
  r.delete('/roles/:key', requireCsrf, requireAction('settings'), validate({
    body: z.object({ reason: z.string().trim().max(500).optional() }).optional(),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    const reason = (req.body as { reason?: string } | undefined)?.reason ?? (req.query as { reason?: string }).reason;
    res.json(await deleteRole(String(req.params.key), staffActor(staff), reason));
  }));

  // ---- Catalogue hierarchy writes ----
  r.get('/catalogue/tree', requireAction('catalogue'), asyncHandler(async (_req, res) => {
    res.json({ items: await catalogueTree() });
  }));
  r.post('/catalogue/master-sheet', requireCsrf, requireAction('catalogue'), validate({
    body: z.object({ csv: z.string().trim().min(1).max(2_000_000) }),
  }), asyncHandler(async (req, res) => {
    const report = await syncCatalogFromCsv(req.body.csv, 'dashboard master sheet', fetch, { checkImages: false });
    if (report.accessError) throw unprocessable(report.accessError);
    res.json({
      imported: report.imported,
      created: report.created,
      updated: report.updated,
      unchanged: report.unchanged,
      skipped: report.skipped,
      invalid: report.invalid,
    });
  }));
  r.post('/catalogue/categories', requireCsrf, requireAction('catalogue'), validate({
    body: z.object({
      name: z.string().trim().min(2).max(120),
      slug: z.string().trim().max(80).optional(),
      description: z.string().trim().max(500).optional(),
      sort: z.number().int().optional(),
      subcategories: z.array(z.string().trim().min(2).max(120)).max(50).optional(),
    }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.status(201).json(await createCategory(req.body as Parameters<typeof createCategory>[0], staffActor(staff)));
  }));
  r.patch('/catalogue/categories/:slug', requireCsrf, requireAction('catalogue'), validate({
    body: z.object({
      name: z.string().trim().min(2).max(120).optional(),
      description: z.string().trim().max(500).optional(),
      sort: z.number().int().optional(),
      active: z.boolean().optional(),
    }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.json(await updateCategory(String(req.params.slug), req.body as Parameters<typeof updateCategory>[1], staffActor(staff)));
  }));
  r.delete('/catalogue/categories/:slug', requireCsrf, requireAction('catalogue'), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.json(await deleteCategory(String(req.params.slug), staffActor(staff)));
  }));

  r.post('/catalogue/subcategories', requireCsrf, requireAction('catalogue'), validate({
    body: z.object({ categorySlug: z.string().min(1).max(80), name: z.string().trim().min(2).max(120), slug: z.string().trim().max(80).optional() }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.status(201).json(await createSubcategory(req.body as Parameters<typeof createSubcategory>[0], staffActor(staff)));
  }));
  r.patch('/catalogue/subcategories/:slug', requireCsrf, requireAction('catalogue'), validate({
    body: z.object({ name: z.string().trim().min(2).max(120).optional(), active: z.boolean().optional(), sort: z.number().int().optional() }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.json(await updateSubcategory(String(req.params.slug), req.body as Parameters<typeof updateSubcategory>[1], staffActor(staff)));
  }));
  r.delete('/catalogue/subcategories/:slug', requireCsrf, requireAction('catalogue'), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.json(await deleteSubcategory(String(req.params.slug), staffActor(staff)));
  }));

  r.post('/catalogue/minerals', requireCsrf, requireAction('catalogue'), validate({
    body: z.object({
      categorySlug: z.string().min(1).max(80),
      name: z.string().trim().min(2).max(120),
      slug: z.string().trim().max(80).optional(),
      subcategorySlug: z.string().trim().max(80).optional(),
      mineralCode: z.string().trim().max(24).optional(),
      sellable: z.boolean().optional(),
    }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.status(201).json(await createMineral(req.body as Parameters<typeof createMineral>[0], staffActor(staff)));
  }));
  r.patch('/catalogue/minerals/:slug', requireCsrf, requireAction('catalogue'), validate({
    body: z.object({
      name: z.string().trim().min(2).max(120).optional(),
      active: z.boolean().optional(),
      sellable: z.boolean().optional(),
      mineralCode: z.string().trim().max(24).optional(),
      categorySlug: z.string().trim().min(1).max(80).optional(),
      sort: z.number().int().optional(),
    }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.json(await updateMineral(String(req.params.slug), req.body as Parameters<typeof updateMineral>[1], staffActor(staff)));
  }));
  r.delete('/catalogue/minerals/:slug', requireCsrf, requireAction('catalogue'), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.json(await deleteMineral(String(req.params.slug), staffActor(staff)));
  }));

  // ---- Lot media (images and documents) ----
  r.get('/catalogue/lots/:ref/media', requireAction('catalogue'), asyncHandler(async (req, res) => {
    res.json(await listLotMedia(String(req.params.ref)));
  }));
  r.post('/catalogue/lots/:ref/media', requireCsrf, requireAction('catalogue'), validate({
    body: z.object({
      kind: z.enum(['image', 'document']).optional(),
      filename: z.string().trim().min(1).max(180),
      contentType: z.string().min(3).max(120),
      contentBase64: z.string().min(8),
      caption: z.string().trim().max(200).optional(),
      name: z.string().trim().max(160).optional(),
      type: z.string().trim().max(60).optional(),
    }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.status(201).json(await addLotMedia(String(req.params.ref), req.body as Parameters<typeof addLotMedia>[1], staffActor(staff)));
  }));
  r.patch('/catalogue/lots/:ref/media/:mediaId', requireCsrf, requireAction('catalogue'), validate({
    body: z.object({
      caption: z.string().trim().max(200).optional(),
      cover: z.boolean().optional(),
      move: z.enum(['up', 'down']).optional(),
      name: z.string().trim().max(160).optional(),
      type: z.string().trim().max(60).optional(),
      visible: z.boolean().optional(),
      replace: z.object({
        filename: z.string().trim().min(1).max(180),
        contentType: z.string().min(3).max(120),
        contentBase64: z.string().min(8),
      }).optional(),
    }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.json(await updateLotMedia(String(req.params.ref), String(req.params.mediaId), req.body as Parameters<typeof updateLotMedia>[2], staffActor(staff)));
  }));
  r.delete('/catalogue/lots/:ref/media/:mediaId', requireCsrf, requireAction('catalogue'), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.json(await removeLotMedia(String(req.params.ref), String(req.params.mediaId), staffActor(staff)));
  }));
  r.get('/catalogue/lots/:ref/media/:mediaId/download', requireAction('catalogue'), asyncHandler(async (req, res) => {
    res.json(await downloadLotMedia(String(req.params.ref), String(req.params.mediaId)));
  }));

  // ---- Stock ----
  const stockBody = z.object({
    deltaGrams: z.number().int().optional(),
    avail: z.number().nonnegative().optional(),
    unit: z.enum(['g', 'kg', 't']).optional(),
    reason: z.string().trim().min(3).max(500),
    kind: z.enum(['add', 'remove', 'count']).optional(),
  });
  const stockHandler = asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.json(await adjustLotStock(String(req.params.ref), req.body as Parameters<typeof adjustLotStock>[1], staffActor(staff)));
  });
  r.post('/catalogue/lots/:ref/stock', requireCsrf, requireAction('catalogue'), validate({ body: stockBody }), stockHandler);
  r.patch('/catalogue/lots/:ref/stock', requireCsrf, requireAction('catalogue'), validate({ body: stockBody }), stockHandler);

  // ---- Order delete (soft) ----
  r.delete('/orders/:ref', requireCsrf, requireAction('ops'), validate({
    body: z.object({ reason: z.string().trim().max(2000).optional(), force: z.boolean().optional() }).optional(),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    const b = (req.body ?? {}) as { reason?: string; force?: boolean };
    const q = req.query as { reason?: string; force?: string };
    const reason = (b.reason ?? q.reason ?? '').trim();
    if (reason.length < 5) throw unprocessable('Give a reason of at least 5 characters.', { reason: 'Required' });
    res.json(await adminV2OrdersService.remove(String(req.params.ref), {
      reason,
      force: b.force ?? q.force === 'true',
      canForce: staffHasAction(staff, 'finance'),
      staff: { id: staff.id, publicId: staff.publicId, name: staff.name, role: staff.roleKey ?? staff.role?.name },
    }));
  }));

  r.post('/orders/:ref/invoice', requireCsrf, requireAction('finance'), validate({
    body: z.object({ rate: z.number().min(0) }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.status(201).json(await issueConsoleInvoice(String(req.params.ref), (req.body as { rate: number }).rate, { id: staff.id, name: staff.name }));
  }));

  r.post('/documents/:number/cancel', requireCsrf, requireAction('ops', 'settings'), validate({
    body: z.object({ reason: z.string().min(3) }),
  }), asyncHandler(async (req, res) => {
    const { staff } = getStaffContext(req);
    res.json(await v2DocumentsService.cancel(String(req.params.number), (req.body as { reason: string }).reason, {
      kind: 'staff', id: staff.id, name: staff.name,
    }));
  }));

  return r;
}
