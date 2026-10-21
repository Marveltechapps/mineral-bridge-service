import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import { createAdminRouter } from '../../src/app-clients/admin/routes.js';
import { errorHandler, notFoundHandler } from '../../src/common/middleware/error-handler.js';
import { requestContext } from '../../src/common/middleware/request-context.js';
import { Role } from '../../src/modules/auth/auth.models.js';
import { DEFAULT_ROLES } from '../../src/modules/staff/default-roles.js';
import { createStaff } from '../../src/modules/staff/staff.service.js';

export const PASSWORD = 'Correct-Horse-9!Battery';
let replSet: MongoMemoryReplSet | undefined;

/** Single-node replica set: the admin API uses multi-document transactions. */
export async function startAdminDb(): Promise<void> {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(replSet.getUri(), { dbName: 'mb_admin_test' });
}

export async function stopAdminDb(): Promise<void> {
  await mongoose.disconnect();
  await replSet?.stop();
}

/** Build every index (unique constraints power idempotency, counters, partial uniques …). */
export async function initIndexes(): Promise<void> {
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));
}

export async function clearAdminDb(): Promise<void> {
  const cols = await mongoose.connection.db!.collections();
  await Promise.all(cols.map((c) => c.deleteMany({})));
}

/** The /admin/v1 surface with the same middleware order as src/app.ts (kept independent of the customer router). */
export function buildAdminApp(): Express {
  const app = express();
  app.use(requestContext);
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));
  app.use('/admin/v1', createAdminRouter());
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export async function seedRoles(): Promise<void> {
  for (const r of DEFAULT_ROLES) {
    await Role.updateOne({ roleId: r.id }, { $set: { name: r.name, description: r.scope, scope: r.scope, system: true, access: r.access } }, { upsert: true });
  }
}

let phoneSeq = 0;
export async function makeStaff(roleId: string, label: string) {
  phoneSeq += 1;
  return createStaff({ email: `${label}@mineralbridge.co.ke`, password: PASSWORD, name: `${label} Tester`, phone: `+2547000${String(phoneSeq).padStart(5, '0')}`, roleId });
}

export type Session = ReturnType<typeof wrap>;

function wrap(agent: ReturnType<typeof request.agent>, csrf: string, cookie: string) {
  const withCsrf = (t: request.Test, headers?: Record<string, string>) => {
    t.set('X-CSRF-Token', csrf);
    for (const [k, v] of Object.entries(headers ?? {})) t.set(k, v);
    return t;
  };
  return {
    csrf,
    cookie,
    get: (url: string, headers?: Record<string, string>) => withCsrf(agent.get(`/admin/v1${url}`), headers),
    post: (url: string, body?: object, headers?: Record<string, string>) => withCsrf(agent.post(`/admin/v1${url}`).send(body ?? {}), headers),
    put: (url: string, body?: object, headers?: Record<string, string>) => withCsrf(agent.put(`/admin/v1${url}`).send(body ?? {}), headers),
    patch: (url: string, body?: object, headers?: Record<string, string>) => withCsrf(agent.patch(`/admin/v1${url}`).send(body ?? {}), headers),
    /** Same session but WITHOUT the CSRF header. */
    postNoCsrf: (url: string, body?: object) => agent.post(`/admin/v1${url}`).send(body ?? {}),
  };
}

/** Password sign-in issues the staff session cookie and CSRF token. */
export async function signIn(app: Express, email: string): Promise<Session> {
  const agent = request.agent(app);
  const step1 = await agent.post('/admin/v1/auth/sign-in').send({ email, password: PASSWORD });
  if (step1.status !== 200 || !step1.body?.me) {
    throw new Error(`sign-in failed: ${step1.status} ${JSON.stringify(step1.body)}`);
  }
  const setCookie = step1.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [])
    .map((c) => c.split(';')[0])
    .join('; ');
  const csrf = String(step1.headers['x-csrf-token'] ?? step1.body.me.csrfToken ?? '');
  return wrap(agent, csrf, cookie);
}
