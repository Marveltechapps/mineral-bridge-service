import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminRouteDefs } from '../../src/app-clients/admin/routes.js';
import { buildAdminApp, initIndexes, makeStaff, seedRoles, signIn, startAdminDb, stopAdminDb, type Session } from '../helpers/admin-harness.js';

let app: Express;
let ceo: Session;

beforeAll(async () => {
  await startAdminDb();
  app = buildAdminApp();
  await initIndexes();
  await seedRoles();
  await makeStaff('ROLE-CEO', 'ceo');
  ceo = await signIn(app, 'ceo@mineralbridge.co.ke');
}, 120_000);
afterAll(stopAdminDb);

/** Endpoints that need a period/period-like query to be valid. */
const QUERY: Record<string, string> = { '/settlements/statement': '?period=2026-09', '/search': '?q=gold', '/auctions': '?status=live', '/network/rankings': '?role=miner' };
/** Valid empty-database answers other than 200. */
const EMPTY_OK: Record<string, number[]> = { '/chain/anchors/latest': [404] };

describe('every parameter-less GET answers on an empty database', () => {
  const gets = adminRouteDefs.filter((d) => d.method === 'GET' && !d.path.includes(':') && !d.sse);
  it('covers a meaningful number of endpoints', () => expect(gets.length).toBeGreaterThan(40));
  for (const d of gets) {
    it(`#${d.n} GET ${d.path}`, async () => {
      const res = await ceo.get(`${d.path}${QUERY[d.path] ?? ''}`);
      expect([200, 202, ...(EMPTY_OK[d.path] ?? [])]).toContain(res.status);
    });
  }
});

describe('unknown ids are 404s, not 500s', () => {
  const gets = adminRouteDefs.filter((d) => d.method === 'GET' && d.path.includes(':') && !d.sse);
  for (const d of gets) {
    it(`#${d.n} GET ${d.path}`, async () => {
      const url = d.path.replace(/:[A-Za-z]+/g, 'NOPE-1');
      const res = await ceo.get(url);
      expect([404, 400, 422]).toContain(res.status);
      expect(res.body.code).toBeTruthy();
    });
  }
});
