/**
 * BUG-022: Admin console must show every customer KYC upload, with a view URL an admin can open.
 * A missing file is marked unavailable. A staff member without KYC access gets 403.
 * @tags bugfix admin kyc
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { opaqueId } from '../../src/common/utils/ids.js';
import { startMemoryReplSet, stopMemoryReplSet } from '../setup.js';

const PASSWORD = 'Correct-Horse-9!Battery';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

describe('bugfix admin kyc BUG-022 customer images visible', () => {
  let app: Express;
  let storageRoot = '';

  beforeAll(async () => {
    await startMemoryReplSet('mb_bug_022');
    storageRoot = mkdtempSync(path.join(os.tmpdir(), 'mb-bug-022-'));
    process.env.STORAGE_LOCAL_ROOT = storageRoot;
    process.env.STORAGE_DRIVER = 'local';
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    const { resetEnvCache } = await import('../../src/config/env.js');
    resetEnvCache();
    const { connectDatabase } = await import('../../src/config/database.js');
    await connectDatabase();
    const { createApp } = await import('../../src/app.js');
    app = createApp();
    const { createStaff } = await import('../../src/modules/staff/staff.service.js');
    await createStaff({ email: 'bug022.ceo@mineralbridge.test', password: PASSWORD, name: 'Bug CEO', roleId: 'ROLE-CEO' });
    await createStaff({ email: 'bug022.support@mineralbridge.test', password: PASSWORD, name: 'Bug Support', roleId: 'ROLE-SUPPORT' });
  }, 120_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await stopMemoryReplSet();
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
  });

  async function signIn(email: string) {
    const agent = request.agent(app);
    const res = await agent.post('/v2/admin/auth/sign-in').set('X-Client', 'admin').send({ email, password: PASSWORD });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const csrf = String(res.headers['x-csrf-token'] || res.body.me?.csrfToken || '');
    const call = (method: 'get' | 'post', url: string) => agent[method](url).set('X-Client', 'admin').set('X-CSRF-Token', csrf);
    return { call, agent };
  }

  async function storeFile(userId: string, filename: string, contentType: string, bytes: Buffer) {
    const { FileModel } = await import('../../src/models/file.model.js');
    const { writeStoredFile } = await import('../../src/modules/storage/storage.service.js');
    const fileId = opaqueId('fil');
    const storageKey = `kyc/${userId}/${fileId}-${filename}`;
    await writeStoredFile(storageKey, bytes);
    await FileModel.create({
      _id: fileId,
      ownerId: userId,
      purpose: 'kyc',
      filename,
      contentType,
      bytes: bytes.length,
      storageKey,
      visibility: 'private',
      refType: 'kyc',
    });
    return fileId;
  }

  it('bug_022_admin_sees_every_kyc_file_with_a_view_url: front, back and company documents open inline', async () => {
    const { UserModel } = await import('../../src/modules/users/user.model.js');
    const { addDocument, setDraftIdType, submitWeb } = await import('../../src/modules/kyc/kyc.service.js');
    const user = await UserModel.create({
      customerNo: 'C-022',
      email: 'ada.kyc@example.com',
      phone: '+2348010000022',
      roles: ['seller'],
      kycStatus: 'none',
      accountStatus: 'active',
      profile: { fullName: 'Ada Miner', companyName: 'Ada Mining', countryCode: 'NG' },
      business: { name: 'Ada Mining', sellerType: 'dealer' },
    });
    const userId = user._id.toString();
    await setDraftIdType(userId, 'nin', 'web');
    const frontId = await storeFile(userId, 'id-front.png', 'image/png', PNG);
    const backId = await storeFile(userId, 'id-back.png', 'image/png', PNG);
    const bizId = await storeFile(userId, 'company-registration.pdf', 'application/pdf', PDF);
    const selfieId = await storeFile(userId, 'selfie.png', 'image/png', PNG);
    const addressId = await storeFile(userId, 'address.png', 'image/png', PNG);
    await addDocument({ userId, kind: 'id_front', fileId: frontId, source: 'web', rejectUnreadable: false, mimeType: 'image/png', originalName: 'id-front.png' });
    await addDocument({ userId, kind: 'id_back', fileId: backId, source: 'web', rejectUnreadable: false, mimeType: 'image/png', originalName: 'id-back.png' });
    await addDocument({ userId, kind: 'business_registration', fileId: bizId, source: 'web', rejectUnreadable: false, mimeType: 'application/pdf', originalName: 'company-registration.pdf' });
    await addDocument({ userId, kind: 'selfie', fileId: selfieId, source: 'web', rejectUnreadable: false, mimeType: 'image/png', originalName: 'selfie.png' });
    await addDocument({ userId, kind: 'proof_of_address', fileId: addressId, source: 'web', rejectUnreadable: false, mimeType: 'image/png', originalName: 'address.png' });
    await submitWeb({ userId });

    const { absoluteStoragePath } = await import('../../src/modules/storage/storage.service.js');
    const { FileModel } = await import('../../src/models/file.model.js');
    const { rm } = await import('node:fs/promises');
    const missing = await FileModel.findById(addressId).lean();
    await rm(absoluteStoragePath(missing!.storageKey));

    const ceo = await signIn('bug022.ceo@mineralbridge.test');
    const snap = await ceo.call('get', '/v2/admin/console?page=1&pageSize=50');
    expect(snap.status).toBe(200);
    const row = (snap.body.kyc as Array<{ ref: string; cust: string; status: string; docs: Array<Record<string, string>> }>).find((k) => k.cust === 'C-022');
    expect(row).toBeTruthy();
    expect(row!.status).toBe('pending');

    const byKind = Object.fromEntries(row!.docs.map((d) => [d.kind, d]));
    expect(byKind.idFront?.url).toMatch(/\/v2\/admin\/files\/.+\/content$/);
    expect(byKind.idBack?.url).toMatch(/\/v2\/admin\/files\/.+\/content$/);
    expect(byKind.business?.url).toMatch(/\/v2\/admin\/files\/.+\/content$/);
    expect(byKind.idFront?.label).toMatch(/front/i);
    expect(byKind.idBack?.label).toMatch(/back/i);
    expect(byKind.business?.label).toMatch(/business/i);
    expect(byKind.address?.availability).toBe('unavailable');
    expect(byKind.address?.url).toBe('');

    const front = await ceo.call('get', byKind.idFront!.url);
    expect(front.status, JSON.stringify(front.body)).toBe(200);
    const cookieOnly = await ceo.agent.get(byKind.idFront!.url);
    expect(cookieOnly.status, JSON.stringify(cookieOnly.body)).toBe(200);
    expect(cookieOnly.headers['content-type']).toMatch(/image\/png/);
    expect(front.headers['content-type']).toMatch(/image\/png/);
    expect(front.headers['content-disposition']).toMatch(/inline/i);
    expect(Buffer.isBuffer(front.body) ? front.body.equals(PNG) : Buffer.from(front.body).equals(PNG)).toBe(true);

    const company = await ceo.call('get', byKind.business!.url);
    expect(company.status).toBe(200);
    expect(company.headers['content-type']).toMatch(/application\/pdf/);
    expect(company.headers['content-disposition']).toMatch(/inline/i);
  });

  it('bug_022_non_admin_kyc_file_forbidden: support staff cannot open a KYC file', async () => {
    const ceo = await signIn('bug022.ceo@mineralbridge.test');
    const snap = await ceo.call('get', '/v2/admin/console?page=1&pageSize=50');
    const row = (snap.body.kyc as Array<{ cust: string; docs: Array<{ kind: string; url: string }> }>).find((k) => k.cust === 'C-022');
    const url = row?.docs.find((d) => d.kind === 'idFront')?.url;
    expect(url).toBeTruthy();

    const support = await signIn('bug022.support@mineralbridge.test');
    const denied = await support.call('get', url!);
    expect(denied.status).toBe(403);

    const anon = await request(app).get(url!).set('X-Client', 'admin');
    expect(anon.status).toBe(401);
  });

  it('bug_022_customer_kyc_status_unchanged: a pending submission stays pending and is not approved', async () => {
    const ceo = await signIn('bug022.ceo@mineralbridge.test');
    const snap = await ceo.call('get', '/v2/admin/console?page=1&pageSize=50');
    const customer = (snap.body.customers as Array<{ id: string; kyc: string }>).find((c) => c.id === 'C-022');
    expect(customer?.kyc).toBe('pending');
  });
});
