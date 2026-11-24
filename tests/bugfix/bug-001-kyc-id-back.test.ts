/**
 * BUG-001: National ID back side must upload and persist under a distinct storage key.
 * @tags bugfix kyc
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FileModel } from '../../src/models/file.model.js';
import {
  addDocument,
  ensureDraft,
  getKycView,
  listActiveDocuments,
  requiredKycDocKinds,
  setDraftIdType,
} from '../../src/modules/kyc/kyc.service.js';
import { clearDb, createUser, startDb, stopDb } from '../helpers/harness.js';

describe('bugfix kyc BUG-001 national id back', () => {
  beforeAll(async () => {
    await startDb();
  }, 120_000);
  afterAll(async () => {
    await stopDb();
  });
  beforeEach(async () => {
    await clearDb();
  });

  async function seedFile(userId: string, name: string) {
    const _id = `fil_${name.replace(/\W/g, '').slice(0, 10)}${Math.floor(Math.random() * 1e5)}`;
    await FileModel.create({
      _id,
      ownerId: userId,
      purpose: 'kyc',
      filename: name,
      contentType: 'image/jpeg',
      bytes: 2048,
      storageKey: `cust/${userId}/${_id}/${name}`,
    });
    return _id;
  }

  it('bug_001_front_then_back_both_stored: two distinct storage keys, and the KYC record holds both', async () => {
    const userId = await createUser({ kycStatus: 'none', profile: { fullName: 'Ada' } });
    // Draft with no explicit PATCH — still must accept id_back (BUG-001).
    await ensureDraft(userId, 'web');
    const view0 = await getKycView(userId);
    expect(
      requiredKycDocKinds({
        idTypeId: view0.active?.idTypeId,
        isBusiness: false,
      }),
    ).toContain('id_back');

    const frontId = await seedFile(userId, 'front.jpg');
    const backId = await seedFile(userId, 'back.jpg');
    await addDocument({ userId, kind: 'id_front', fileId: frontId, source: 'web', rejectUnreadable: false });
    await addDocument({ userId, kind: 'id_back', fileId: backId, source: 'web', rejectUnreadable: false });

    const view = await getKycView(userId);
    const docs = await listActiveDocuments(view.active!.id);
    const front = docs.find((d) => d.kind === 'id_front');
    const back = docs.find((d) => d.kind === 'id_back');
    expect(front?.fileId).toBe(frontId);
    expect(back?.fileId).toBe(backId);
    expect(front?.fileId).not.toBe(back?.fileId);
  });

  it('bug_001_back_then_front_order_independent', async () => {
    const userId = await createUser({ kycStatus: 'none' });
    await setDraftIdType(userId, 'nin', 'web');
    const backId = await seedFile(userId, 'back-first.jpg');
    const frontId = await seedFile(userId, 'front-second.jpg');
    await addDocument({ userId, kind: 'id_back', fileId: backId, source: 'web', rejectUnreadable: false });
    await addDocument({ userId, kind: 'id_front', fileId: frontId, source: 'web', rejectUnreadable: false });
    const view = await getKycView(userId);
    const docs = await listActiveDocuments(view.active!.id);
    expect(docs.map((d) => d.kind).sort()).toEqual(['id_back', 'id_front']);
  });

  it('bug_001_replace_back_keeps_front', async () => {
    const userId = await createUser({ kycStatus: 'none' });
    await setDraftIdType(userId, 'nin', 'web');
    const frontId = await seedFile(userId, 'front.jpg');
    const back1 = await seedFile(userId, 'back1.jpg');
    const back2 = await seedFile(userId, 'back2.jpg');
    await addDocument({ userId, kind: 'id_front', fileId: frontId, source: 'web', rejectUnreadable: false });
    await addDocument({ userId, kind: 'id_back', fileId: back1, source: 'web', rejectUnreadable: false });
    await addDocument({ userId, kind: 'id_back', fileId: back2, source: 'web', rejectUnreadable: false });
    const view = await getKycView(userId);
    const docs = await listActiveDocuments(view.active!.id);
    expect(docs.find((d) => d.kind === 'id_front')?.fileId).toBe(frontId);
    expect(docs.find((d) => d.kind === 'id_back')?.fileId).toBe(back2);
    expect(docs.filter((d) => d.kind === 'id_back')).toHaveLength(1);
  });
});
