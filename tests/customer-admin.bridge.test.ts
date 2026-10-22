import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { FileModel } from '../src/models/file.model.js';
import { KycDocument } from '../src/models/people.models.js';
import { FileObject } from '../src/models/platform.models.js';
import { Order } from '../src/models/trading.models.js';
import { User } from '../src/models/people.models.js';
import { applyAdminKycToCustomer } from '../src/integration/customer-admin.bridge.js';
import { toWebKycRecord } from '../src/modules/kyc/kyc.mappers.js';
import { addDocument, getKycView, setDraftIdType, submitWeb } from '../src/modules/kyc/kyc.service.js';
import { buildApp, clearDb, createUser, MOBILE, seedProduct, startDb, stopDb } from './helpers/harness.js';

vi.mock('../src/modules/auth/auth.middleware.js', async () => await import('./helpers/fake-auth.js'));

const app = buildApp();

beforeAll(async () => {
  await startDb();
  await Promise.all([Order.init(), User.init()]);
});
afterAll(stopDb);
beforeEach(clearDb);

describe('customer order is visible to the admin collection', () => {
  it('projects a placed order onto the same reference the dashboard reads', async () => {
    const userId = await createUser({ email: 'buyer@example.com', profile: { fullName: 'Amina Yusuf', countryCode: 'NG' } });
    const product = await seedProduct({ availableGrams: 1000 });
    const res = await request(app)
      .post('/v1/orders')
      .set(MOBILE)
      .set('x-test-user', userId)
      .set('Idempotency-Key', 'bridge-order-1')
      .send({
        productId: product._id,
        quantity: { value: 100, unit: 'g' },
        delivery: {
          facilityName: 'Kano Refinery',
          streetAddress: '12 Bompai Road',
          city: 'Kano',
          country: 'NG',
          contactPerson: 'Amina Yusuf',
          contactPhone: '+2348012345678',
        },
        acceptedTerms: true,
      });
    expect(res.status).toBe(201);
    const adminUser = await User.findOne({ userId }).lean();
    expect(adminUser?.name).toBe('Amina Yusuf');
    const adminOrders = await Order.find({ counterpartyId: userId }).lean();
    expect(adminOrders).toHaveLength(1);
    expect(adminOrders[0]?.mineral.name).toBe('Gold dore bar');
    expect(adminOrders[0]?.stage).toBe('verification');
  });
});

describe('customer KYC documents reach the compliance queue', () => {
  it('projects both sides and returns the reviewer reason to the customer', async () => {
    const userId = await createUser({
      kycStatus: 'none',
      profile: { fullName: 'Dhanasekar', companyName: 'Solo' },
    });
    const files = [
      ['fil_frontside1', 'front.jpg', 'id_front'],
      ['fil_backside01', 'back.jpg', 'id_back'],
      ['fil_selfieimg1', 'selfie.jpg', 'selfie'],
    ] as const;
    for (const [fileId, filename] of files) {
      await FileModel.create({
        _id: fileId,
        ownerId: userId,
        purpose: 'document',
        filename,
        contentType: 'image/jpeg',
        bytes: 2048,
        storageKey: `cust/${userId}/${fileId}/${filename}`,
      });
    }
    await setDraftIdType(userId, 'nin', 'web');
    for (const [fileId, , kind] of files) {
      await addDocument({ userId, kind, fileId, source: 'web', rejectUnreadable: false });
    }
    const submission = await submitWeb({ userId });
    const reference = submission.reference!;
    const adminDocs = await KycDocument.find({ kycId: reference }).sort({ type: 1 }).lean();
    expect(adminDocs.map((doc) => doc.name)).toEqual([
      'National ID (NIN) — back',
      'National ID (NIN) — front',
      'Liveness selfie',
    ]);
    expect(adminDocs.map((doc) => doc.side).sort()).toEqual(['back', 'front', 'selfie']);
    expect(adminDocs.every((doc) => doc.fileId && doc.mimeType === 'image/jpeg')).toBe(true);
    expect(await FileObject.countDocuments({ fileId: { $in: files.map(([id]) => id) } })).toBe(3);

    await applyAdminKycToCustomer({
      kycId: reference,
      staffId: 'STF-TEST',
      decision: 'request_resubmission',
      reason: 'The back of the ID is blurry. Retake both sides in even light.',
      documentIds: [`${reference}:id_back`],
    });

    const web = toWebKycRecord(await getKycView(userId));
    expect(web.status).toBe('rejected');
    expect(web.resubmissionRequired).toBe(true);
    expect(web.rejectionReason).toBe('The back of the ID is blurry. Retake both sides in even light.');
    const back = web.documents.find((doc) => doc.side === 'back');
    const front = web.documents.find((doc) => doc.side === 'front');
    expect(back).toMatchObject({
      status: 'rejected',
      rejectionReason: 'The back of the ID is blurry. Retake both sides in even light.',
      fileId: 'fil_backside01',
    });
    expect(front).toMatchObject({ status: 'verified', rejectionReason: null, fileId: 'fil_frontside1' });
  });
});
