import express from 'express';
import type { Express } from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { buildCustomerV1Router } from '../../src/app-clients/v1.js';
import { errorHandler, notFoundHandler } from '../../src/common/middleware/error-handler.js';
import { requestContext } from '../../src/common/middleware/request-context.js';
import { AuctionModel, BidModel, CartModel, ContractModel, CounterModel, IdempotencyModel, LedgerModel, LetterOfCreditModel, NegotiationModel, NotificationModel, OrderModel, ProductModel } from '../../src/models/index.js';
import { PaymentModel, RefundModel, SellerPayoutModel, IssuedDocumentModel } from '../../src/models/workflow.model.js';
import { SupportTicketModel } from '../../src/models/support.model.js';
import { UserModel as CoreUserModel } from '../../src/modules/users/user.model.js';
import { setClock } from '../../src/common/utils/clock.js';

let mongod: MongoMemoryServer | undefined;

export async function startDb(): Promise<void> {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'mb_test' });
  // Unique indexes (idempotency claim, bid seq, settlement key) are what make the concurrency tests meaningful.
  await Promise.all([
    AuctionModel, BidModel, CartModel, ContractModel, CounterModel, IdempotencyModel, LedgerModel,
    LetterOfCreditModel, NegotiationModel, NotificationModel, OrderModel, ProductModel,
    PaymentModel, RefundModel, SellerPayoutModel, IssuedDocumentModel, SupportTicketModel,
  ].map((m) => m.init()));
}

export async function stopDb(): Promise<void> {
  setClock(null);
  // Force-close so in-flight ops (SSE / long polls) cannot reject after Vitest tears down the file.
  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close(true);
    }
  } catch {
    /* ignore mid-flight interruption during teardown */
  }
  try {
    await mongod?.stop();
  } catch {
    /* ignore */
  }
  mongod = undefined;
}

export async function clearDb(): Promise<void> {
  setClock(null);
  const cols = await mongoose.connection.db!.collections();
  await Promise.all(cols.map((c) => c.deleteMany({})));
}

export function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use('/v1', buildCustomerV1Router({ includeAuth: false }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export const MOBILE = { 'x-client': 'mineralbridge-mobile/1.0' } as const;
export const WEB = { 'x-client': 'mineralbridge-web/1.0' } as const;

export async function createUser(over: Record<string, unknown> = {}): Promise<string> {
  const doc = await CoreUserModel.create({
    phone: `+23480${Math.floor(Math.random() * 1e8)}`,
    kycStatus: 'verified',
    tier: 2,
    ...over,
  });
  return doc._id.toString();
}

export async function seedProduct(over: Record<string, unknown> = {}) {
  const n = Math.floor(Math.random() * 1e9);
  return ProductModel.create({
    reference: `MBP-${n}`,
    name: 'Gold dore bar',
    typeSlug: 'gold-dore',
    categorySlug: 'precious-metals',
    mineralCode: 'AU',
    origin: { country: 'GH' },
    availableGrams: 10_000,
    unitPriceMinorE4PerGram: 6_500_000,
    ...over,
  });
}
