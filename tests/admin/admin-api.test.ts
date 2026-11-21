import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminRouteRegistry } from '../../src/app-clients/admin/routes.js';
import { Banner } from '../../src/models/content.models.js';
import { Dispute, KycDocument, KycSubmission, TierRequest, User } from '../../src/models/people.models.js';
import { Auction, Settlement } from '../../src/models/trading.models.js';
import { AuditLog } from '../../src/modules/audit/audit.model.js';
import { emitAuctionEvent } from '../../src/modules/admin/auctions/auctions.service.js';
import { DEFAULT_ROLES } from '../../src/modules/staff/default-roles.js';
import { buildAdminApp, clearAdminDb, initIndexes, makeStaff, seedRoles, signIn, startAdminDb, stopAdminDb, type Session } from '../helpers/admin-harness.js';

let app: Express;
let ceo: Session;
let compliance: Session;
let limited: Session;
let complianceStaffId: string;
let ceoStaffId: string;

const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD', scale: 2 });

async function seedUser(over: Record<string, unknown> = {}) {
  return User.create({ userId: 'USR-10401', name: 'Rift Valley Minerals Ltd', org: 'Rift Valley Minerals Ltd', email: 'ops@riftvalley.example', phone: '+254711000111', tier: 2, status: 'verified', kycStatus: 'verified', country: 'KE', ...over });
}

beforeAll(async () => {
  await startAdminDb();
  app = buildAdminApp();
  await initIndexes();
});
afterAll(stopAdminDb);

beforeEach(async () => {
  await clearAdminDb();
  await seedRoles();
  const [c, k, l] = await Promise.all([makeStaff('ROLE-CEO', 'ceo'), makeStaff('ROLE-COMPLIANCE', 'compliance'), makeStaff(DEFAULT_ROLES.find((r) => r.access.orders === 'none' && r.access.compliance === 'none')?.id ?? 'ROLE-CONTENT', 'limited')]);
  ceoStaffId = c.publicId;
  complianceStaffId = k.publicId;
  void l;
  ceo = await signIn(app, 'ceo@mineralbridge.co.ke');
  compliance = await signIn(app, 'compliance@mineralbridge.co.ke');
  limited = await signIn(app, 'limited@mineralbridge.co.ke');
});

describe('route registry', () => {
  it('registers endpoints #13–139 exactly once and the auth router for #1–12', () => {
    const reg = adminRouteRegistry();
    const numbered = reg.filter((r) => r.n !== null).map((r) => r.n as number).sort((a, b) => a - b);
    expect(numbered).toEqual([...Array.from({ length: 127 }, (_, i) => i + 13), 142]);
    const auth = reg.filter((r) => r.source === 'auth');
    const authKeys = auth.map((r) => `${r.method} ${r.path}`);
    expect(authKeys).toEqual(
      expect.arrayContaining([
        'GET /auth/dev-login',
        'POST /auth/dev-login',
        'POST /auth/dev-login/verify',
      ]),
    );
    expect(auth).toHaveLength(15);
    const keys = reg.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('auth, permissions and CSRF', () => {
  it('rejects anonymous callers', async () => {
    const r = await (await import('supertest')).default(app).get('/admin/v1/orders');
    expect(r.status).toBe(401);
  });

  it('serves a page with the AdminPage envelope to a permitted role', async () => {
    const r = await ceo.get('/orders');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ data: [], meta: { page: 1, total: 0 } });
  });

  it('forbids modules the role cannot see', async () => {
    const r = await limited.get('/orders');
    expect(r.status).toBe(403);
    expect(r.body.code).toMatch(/^auth\//);
  });

  it('requires the CSRF header on mutations', async () => {
    await seedUser();
    const r = await ceo.postNoCsrf('/users/USR-10401/messages', { body: 'hello', channels: ['in_app'] });
    expect(r.status).toBe(403);
  });
});

describe('idempotency', () => {
  it('replays the stored response for the same key and body, and rejects a different body', async () => {
    await seedUser();
    const headers = { 'Idempotency-Key': 'msg-1' };
    const first = await ceo.post('/users/USR-10401/messages', { body: 'Your documents are approved.', channels: ['in_app'] }, headers);
    expect(first.status).toBe(201);
    const second = await ceo.post('/users/USR-10401/messages', { body: 'Your documents are approved.', channels: ['in_app'] }, headers);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body.id).toBe(first.body.id);
    const other = await ceo.post('/users/USR-10401/messages', { body: 'Something else', channels: ['in_app'] }, headers);
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('conflict/duplicate');
  });
});

describe('tier requests (#95–97)', () => {
  it('creates, blocks duplicates and same-tier requests, then approves into a KYC submission', async () => {
    await seedUser();
    const same = await ceo.post('/tier-requests', { userId: 'USR-10401', toTier: 2, reason: 'no change' });
    expect(same.status).toBe(422);
    expect(same.body.code).toBe('rule/same-tier');

    const created = await ceo.post('/tier-requests', { userId: 'USR-10401', toTier: 3, reason: 'Wants to bid on auctions' });
    expect(created.status).toBe(201);
    const dup = await ceo.post('/tier-requests', { userId: 'USR-10401', toTier: 3, reason: 'again' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('conflict/duplicate');

    const requestId = created.body.data.id as string;
    const deny = await compliance.post(`/tier-requests/${requestId}/decision`, { decision: 'deny' });
    expect(deny.status).toBe(422);

    const ok = await compliance.post(`/tier-requests/${requestId}/decision`, { decision: 'approve' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('approved');
    expect(ok.body.auditId).toMatch(/^AUD-/);
    expect((await User.findOne({ userId: 'USR-10401' }).lean())?.tier).toBe(3);
    expect(await KycSubmission.countDocuments({ userId: 'USR-10401', tier: 3 })).toBe(1);

    const again = await compliance.post(`/tier-requests/${requestId}/decision`, { decision: 'approve' });
    expect(again.status).toBe(409);
    expect(await TierRequest.countDocuments({ status: 'pending' })).toBe(0);
  });
});

describe('KYC decisions (#98–101)', () => {
  it('refuses approval while a document is rejected, then approves and verifies the user', async () => {
    await seedUser({ tier: 1, status: 'in_review', kycStatus: 'pending' });
    await KycSubmission.create({ kycId: 'KYC-7701', userId: 'USR-10401', person: 'Amina W.', org: 'Rift Valley Minerals Ltd', tier: 2, submittedAt: new Date(Date.now() - 3 * 86_400_000), status: 'in_review' });
    await KycDocument.create({ docId: 'DOC-00001', kycId: 'KYC-7701', userId: 'USR-10401', type: 'Mining licence', name: 'licence.pdf', tier: 2, status: 'rejected', rejectionReason: 'Unreadable scan', expiresOn: new Date(Date.now() + 20 * 86_400_000) });

    const list = await compliance.get('/compliance/kyc');
    expect(list.status).toBe(200);
    expect(list.body.data[0]).toMatchObject({ id: 'KYC-7701', overdue: true });
    expect(list.body.data[0].documents[0]).toMatchObject({ rejectionReason: 'Unreadable scan', fileId: null });

    const blocked = await compliance.post('/compliance/kyc/KYC-7701/decision', { decision: 'approve' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe('rule/documents-unverified');

    const missingReason = await compliance.post('/compliance/kyc/KYC-7701/decision', { decision: 'reject', reason: 'no' });
    expect(missingReason.status).toBe(422);

    await KycDocument.updateOne({ docId: 'DOC-00001' }, { $set: { status: 'verified' }, $unset: { rejectionReason: '' } });
    const ok = await compliance.post('/compliance/kyc/KYC-7701/decision', { decision: 'approve' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('verified');
    expect((await User.findOne({ userId: 'USR-10401' }).lean())?.tier).toBe(2);

    const docs = await compliance.get('/compliance/documents');
    expect(docs.body.meta.counts.expiringWithin35).toBe(1);
    expect(docs.body.data[0].status).toBe('expiring');
  });

  it('approves documents that are still in review and stores a rejection reason', async () => {
    await seedUser({ tier: 1, status: 'in_review', kycStatus: 'pending' });
    await KycSubmission.create({ kycId: 'KYC-7702', userId: 'USR-10401', person: 'Amina W.', org: 'Rift Valley Minerals Ltd', tier: 2, status: 'in_review' });
    await KycDocument.create({ docId: 'KYC-7702:id_front', kycId: 'KYC-7702', userId: 'USR-10401', type: 'id_front', name: 'National ID — front', side: 'front', fileId: 'fil_frontside1', tier: 1, status: 'in_review' });
    await KycDocument.create({ docId: 'KYC-7702:id_back', kycId: 'KYC-7702', userId: 'USR-10401', type: 'id_back', name: 'National ID — back', side: 'back', fileId: 'fil_backside01', tier: 1, status: 'in_review' });

    const approved = await compliance.post('/compliance/kyc/KYC-7702/decision', { decision: 'approve' });
    expect(approved.status).toBe(200);
    expect(await KycDocument.countDocuments({ kycId: 'KYC-7702', status: 'verified' })).toBe(2);

    await KycSubmission.create({ kycId: 'KYC-7703', userId: 'USR-10401', person: 'Amina W.', tier: 1, status: 'in_review' });
    await KycDocument.create({ docId: 'KYC-7703:id_front', kycId: 'KYC-7703', userId: 'USR-10401', type: 'id_front', name: 'National ID — front', tier: 1, status: 'in_review' });
    const rejected = await compliance.post('/compliance/kyc/KYC-7703/decision', { decision: 'reject', reason: 'The photo is cut off on the right.' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.documents[0]).toMatchObject({ status: 'rejected', rejectionReason: 'The photo is cut off on the right.' });

    const again = await compliance.post('/compliance/kyc/KYC-7704/decision', { decision: 'request_resubmission', reason: 'Retake both sides in even light.' });
    expect(again.status).toBe(404);
  });
});

describe('disputes (#106) — four-eyes, idempotency and settlement posting', () => {
  beforeEach(async () => {
    await seedUser();
    await Dispute.create({ disputeId: 'DSP-2026-0061', linked: { type: 'order', id: 'MB-SELL-41982' }, type: 'assay_variance', partyId: 'USR-10401', status: 'evidence_review', valueAtRisk: usd(1_420_000), createdBy: complianceStaffId, raisedBy: { kind: 'staff', id: complianceStaffId } });
  });
  const body = { outcome: 'settlement_adjusted', adjustment: { amount: -14200, currency: 'USD' }, note: 'Re-assay confirmed 88.4% Au; settlement adjusted.' };

  it('requires an Idempotency-Key', async () => {
    const r = await ceo.post('/disputes/DSP-2026-0061/resolution', body);
    expect(r.status).toBe(400);
  });

  it('blocks the person who raised the dispute from resolving it', async () => {
    const r = await compliance.post('/disputes/DSP-2026-0061/resolution', body, { 'Idempotency-Key': 'res-1' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('auth/four-eyes');
  });

  it('needs an adjustment for adjusting outcomes', async () => {
    const r = await ceo.post('/disputes/DSP-2026-0061/resolution', { outcome: 'credit_issued', note: 'goodwill credit' }, { 'Idempotency-Key': 'res-2' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('rule/adjustment-required');
  });

  it('resolves, posts exactly one settlement, and replays safely', async () => {
    const first = await ceo.post('/disputes/DSP-2026-0061/resolution', body, { 'Idempotency-Key': 'res-3' });
    expect(first.status).toBe(200);
    expect(first.body.data.status).toBe('resolved');
    expect(first.body.data.resolution.adjustment).toEqual({ amount: -14200, currency: 'USD' });
    const replay = await ceo.post('/disputes/DSP-2026-0061/resolution', body, { 'Idempotency-Key': 'res-3' });
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(await Settlement.countDocuments({ 'ref.id': 'DSP-2026-0061' })).toBe(1);
    const stale = await ceo.post('/disputes/DSP-2026-0061/resolution', body, { 'Idempotency-Key': 'res-4' });
    expect(stale.status).toBe(409);
  });
});

describe('marketing banners (#113–115)', () => {
  const valid = { title: 'Gold week', placement: 'homepage_hero', activeFrom: '2026-10-01', activeUntil: '2026-10-31', linkTarget: '/sell/gold-concentrate' };

  it('validates link targets and dates, and keeps the hero slot exclusive', async () => {
    expect((await ceo.post('/marketing/banners', { ...valid, linkTarget: 'https://evil.example' })).body.code).toBe('rule/link-target-invalid');
    expect((await ceo.post('/marketing/banners', { ...valid, activeUntil: '2026-09-01' })).body.code).toBe('rule/dates');

    const a = await ceo.post('/marketing/banners', valid);
    expect(a.status).toBe(201);
    expect(a.body.active).toBe(false);
    const b = await ceo.post('/marketing/banners', { ...valid, title: 'Second hero' });
    expect((await ceo.patch(`/marketing/banners/${a.body.id}`, { active: true })).status).toBe(200);
    const clash = await ceo.patch(`/marketing/banners/${b.body.id}`, { active: true });
    expect(clash.status).toBe(422);
    expect(clash.body.code).toBe('rule/slot-occupied');
    expect(clash.body.details.conflictingBannerId).toBe(a.body.id);
    expect(await Banner.countDocuments({ active: true })).toBe(1);
  });
});

describe('ETag / If-Match (#129–130)', () => {
  it('rejects a stale If-Match with 412 and accepts the current one', async () => {
    const roles = await ceo.get('/settings/roles');
    expect(roles.status).toBe(200);
    const change = { changes: [{ roleId: 'ROLE-COMPLIANCE', module: 'content', access: 'view' }] };
    const stale = await ceo.put('/settings/roles/permissions', change, { 'If-Match': 'W/"r-9999"' });
    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe('conflict/etag-mismatch');
    const ok = await ceo.put('/settings/roles/permissions', change, { 'If-Match': String(roles.headers.etag ?? roles.body.etag) });
    expect(ok.status).toBe(200);
  });
});

describe('audit trail', () => {
  it('records before/after for privileged writes and is append-only', async () => {
    await seedUser();
    await ceo.post('/tier-requests', { userId: 'USR-10401', toTier: 3, reason: 'Wants to bid' });
    const entries = await AuditLog.find().lean();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.record?.type === 'tier_request')).toBe(true);
    await expect(AuditLog.updateOne({}, { $set: { action: 'tampered' } })).rejects.toThrow(/append-only/);
    await expect(AuditLog.deleteMany({})).rejects.toThrow(/append-only/);
    const page = await ceo.get('/audit-log');
    expect(page.status).toBe(200);
    expect(page.body.meta.retentionYears).toBe(7);
    void ceoStaffId;
  });
});

describe('auction bid stream (#60, SSE)', () => {
  it('sends the current state, then pushes new bids as they happen', async () => {
    await Auction.create({ auctionId: 'AUC-2026-0201', status: 'live', lotId: 'MBV-2026-0400', mineral: { id: 'MIN-AU', name: 'Gold Concentrate' }, quantity: { value: 10, unit: 'kg' }, startingBid: usd(100_000), reserve: usd(150_000), increment: usd(5_000), opensAt: new Date(), endsAt: new Date(Date.now() + 3_600_000) });
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    try {
      const chunks: string[] = [];
      const req = http.get({ port, path: '/admin/v1/auctions/AUC-2026-0201/bids/stream', headers: { Cookie: ceo.cookie, Accept: 'text/event-stream' } });
      const done = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`SSE timeout. Received: ${chunks.join('')}`)), 10_000);
        req.on('response', (res) => {
          expect(res.statusCode).toBe(200);
          expect(String(res.headers['content-type'])).toContain('text/event-stream');
          res.on('data', (d: Buffer) => {
            chunks.push(d.toString());
            const text = chunks.join('');
            if (text.includes('event: state') && !text.includes('event: bid')) void emitAuctionEvent('AUC-2026-0201', 'bid', { bidId: 'BID-000001', amount: { amount: 1100, currency: 'USD' } });
            if (text.includes('event: bid')) { clearTimeout(timer); resolve(); }
          });
        });
        req.on('error', reject);
      });
      await done;
      req.destroy();
      expect(chunks.join('')).toContain('BID-000001');
    } finally {
      server.close();
    }
  });
});
