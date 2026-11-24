import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createV2Router } from '../src/app-clients/v2/routes.js';
import { errorHandler, notFoundHandler } from '../src/common/middleware/error-handler.js';
import { requestContext } from '../src/common/middleware/request-context.js';
import { maskEmail } from '../src/common/utils/phone.js';
import { ensureDraft } from '../src/modules/kyc/kyc.service.js';
import { opaqueId } from '../src/common/utils/ids.js';
import { clearDb, createUser, startDb, stopDb } from './helpers/harness.js';

vi.mock('../src/modules/auth/auth.middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/modules/auth/auth.middleware.js')>();
  const fake = await import('./helpers/fake-v2-auth.js');
  return { ...actual, requireUser: fake.requireUser, getUserContext: fake.getUserContext, optionalUser: fake.optionalUser };
});

function buildV2App() {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use('/v2', createV2Router());
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const MOBILE = { 'x-client': 'mineralbridge-mobile/1.0' } as const;

describe('bugfix maskEmail (BUG-003)', () => {
  it('bug_003_masks_local_part_for_recognition', () => {
    expect(maskEmail('adaeze@example.com')).toBe('ad•••e@example.com');
  });

  it('bug_003_short_local_part_uses_first_char_only', () => {
    expect(maskEmail('ab@example.com')).toBe('a•••@example.com');
  });

  it('bug_003_keeps_domain_intact', () => {
    expect(maskEmail('user.name+tag@mail.co.uk')).toBe('us•••g@mail.co.uk');
  });
});

describe('bugfix KYC v2 (BUG-001, BUG-002)', () => {
  const app = buildV2App();

  beforeAll(startDb, 120_000);
  afterAll(stopDb);
  beforeEach(clearDb);

  it('bug_001_get_kyc_after_draft_includes_id_back_without_prior_patch', async () => {
    const userId = await createUser({ kycStatus: 'none', tier: 1 });
    await ensureDraft(userId, 'web');

    const get = await request(app).get('/v2/kyc').set(MOBILE).set('x-test-user', userId);
    expect(get.status).toBe(200);
    expect(get.body.idType).toBe('national_id');
    expect(get.body.requiredKinds).toEqual(
      expect.arrayContaining(['id_front', 'id_back', 'selfie', 'proof_of_address']),
    );

    const fileId = opaqueId('fil');
    const putBack = await request(app)
      .put('/v2/kyc/documents/id_back')
      .set(MOBILE)
      .set('x-test-user', userId)
      .send({ fileId });
    expect(putBack.status).toBe(200);
    expect(putBack.body.kind).toBe('id_back');
  });

  it('bug_002_investor_with_company_name_does_not_require_business_registration', async () => {
    const userId = await createUser({
      kycStatus: 'none',
      tier: 1,
      roles: ['buyer'],
      business: { buyerType: 'investor', name: 'Okafor Holdings' },
      profile: { companyName: 'Okafor Holdings' },
    });
    await ensureDraft(userId, 'mobile');

    const get = await request(app).get('/v2/kyc').set(MOBILE).set('x-test-user', userId);
    expect(get.status).toBe(200);
    expect(get.body.requiredKinds).not.toContain('business_registration');
  });

  it('bug_002_refinery_requires_business_registration', async () => {
    const userId = await createUser({
      kycStatus: 'none',
      tier: 1,
      roles: ['buyer'],
      business: { buyerType: 'refinery', name: 'Kestrel Metals' },
    });
    await ensureDraft(userId, 'mobile');

    const get = await request(app).get('/v2/kyc').set(MOBILE).set('x-test-user', userId);
    expect(get.status).toBe(200);
    expect(get.body.requiredKinds).toContain('business_registration');
  });
});