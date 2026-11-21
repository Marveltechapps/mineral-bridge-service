/**
 * GET /v2/catalogue/products/:ref/documents/:type — real Mongo metadata + signed download URL.
 */
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createV2Router } from '../src/app-clients/v2/routes.js';
import { verifySignedUrl } from '../src/common/storage/signed-url.js';
import { errorHandler, notFoundHandler } from '../src/common/middleware/error-handler.js';
import { requestContext } from '../src/common/middleware/request-context.js';
import { opaqueId } from '../src/common/utils/ids.js';
import { FileModel } from '../src/models/file.model.js';
import { canonicalDocumentType } from '../src/modules/catalog/product-documents.js';
import { clearDb, createUser, seedProduct, startDb, stopDb } from './helpers/harness.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use('/v2', createV2Router());
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const MOBILE = { 'x-client': 'mobile' } as const;

async function seedFile(over: Record<string, unknown> = {}) {
  const ownerId = await createUser();
  const _id = opaqueId('fil');
  return FileModel.create({
    _id,
    ownerId,
    purpose: 'sell_document',
    filename: 'sgs-report.pdf',
    contentType: 'application/pdf',
    bytes: 2048,
    storageKey: `cust/${ownerId}/${_id}/sgs-report.pdf`,
    scan: { status: 'clean', at: new Date() },
    ...over,
  });
}

describe('GET /v2/catalogue/products/:ref/documents/:type', () => {
  beforeAll(async () => {
    await startDb();
  }, 120_000);
  afterAll(async () => {
    await stopDb();
  });
  beforeEach(async () => {
    await clearDb();
  });

  it('returns a short-lived signed URL for a stored file (guest, by reference)', async () => {
    const file = await seedFile();
    const product = await seedProduct({
      status: 'active',
      lab: { name: 'SGS', certificateNo: 'SGS-NG-26-4471-TR' },
      documents: [{ _id: opaqueId('doc'), name: 'SGS test report', kind: 'lot_test_report', fileId: file._id }],
    });

    const before = Date.now();
    const res = await request(buildApp())
      .get(`/v2/catalogue/products/${product.reference}/documents/lot_test_report`)
      .set(MOBILE);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: 'lot_test_report',
      number: 'SGS-NG-26-4471-TR',
      name: 'SGS test report',
      contentType: 'application/pdf',
      available: true,
      bytes: 2048,
    });
    expect(res.headers['cache-control']).toContain('no-store');

    const url = new URL(res.body.url);
    expect(url.pathname).toBe(`/v1/files/signed/file/${encodeURIComponent(file._id)}`);
    const exp = Number(url.searchParams.get('exp'));
    expect(verifySignedUrl('file', file._id, exp, url.searchParams.get('sig') ?? '')).toBe(true);

    const expiresAt = Date.parse(res.body.expiresAt);
    expect(expiresAt).toBeGreaterThan(before);
    expect(expiresAt - before).toBeLessThanOrEqual(301_000);
  });

  it('resolves by _id and matches alias kinds stored on the product (coa -> certificate_of_analysis)', async () => {
    const file = await seedFile();
    const product = await seedProduct({
      status: 'sold',
      documents: [{ _id: opaqueId('doc'), name: 'Assay CoA', kind: 'COA', fileId: file._id, contentType: 'application/pdf' }],
    });

    const res = await request(buildApp())
      .get(`/v2/catalogue/products/${product._id}/documents/certificate_of_analysis`)
      .set(MOBILE);
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('certificate_of_analysis');
    expect(res.body.number).toBe('Assay CoA');
    expect(res.body.url).toContain('/v1/files/signed/file/');
  });

  it('returns an external url when the document has no stored file', async () => {
    const product = await seedProduct({
      status: 'active',
      documents: [{ _id: opaqueId('doc'), name: 'Origin declaration', kind: 'origin', url: 'https://cdn.example/origin.pdf' }],
    });
    const res = await request(buildApp())
      .get(`/v2/catalogue/products/${product.reference}/documents/origin_declaration`)
      .set(MOBILE);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: 'origin_declaration',
      available: true,
      url: 'https://cdn.example/origin.pdf',
      expiresAt: null,
    });
  });

  it('404 document/not-available when the lot has no matching document', async () => {
    const file = await seedFile();
    const product = await seedProduct({
      status: 'active',
      documents: [{ _id: opaqueId('doc'), name: 'Report', kind: 'lot_test_report', fileId: file._id }],
    });
    const res = await request(buildApp())
      .get(`/v2/catalogue/products/${product.reference}/documents/origin_declaration`)
      .set(MOBILE);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('document/not-available');
  });

  it('404 when the stored file is deleted, empty or not scanned clean', async () => {
    const infected = await seedFile({ scan: { status: 'infected' } });
    const gone = await seedFile({ deletedAt: new Date() });
    for (const file of [infected, gone]) {
      const product = await seedProduct({
        status: 'active',
        documents: [{ _id: opaqueId('doc'), name: 'Report', kind: 'lot_test_report', fileId: file._id }],
      });
      const res = await request(buildApp())
        .get(`/v2/catalogue/products/${product.reference}/documents/lot_test_report`)
        .set(MOBILE);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('document/not-available');
    }
  });

  it('404 for draft and withdrawn products and unknown refs (no leak)', async () => {
    const file = await seedFile();
    const documents = [{ _id: opaqueId('doc'), name: 'Report', kind: 'lot_test_report', fileId: file._id }];
    const draft = await seedProduct({ status: 'draft', documents });
    const withdrawn = await seedProduct({ status: 'withdrawn', documents });
    const app = buildApp();

    for (const ref of [draft.reference, draft._id, withdrawn.reference, 'MBP-does-not-exist']) {
      const res = await request(app).get(`/v2/catalogue/products/${ref}/documents/lot_test_report`).set(MOBILE);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('document/not-available');
    }
  });

  it('422 for an unsupported :type', async () => {
    const product = await seedProduct({ status: 'active' });
    const res = await request(buildApp())
      .get(`/v2/catalogue/products/${product.reference}/documents/passport`)
      .set(MOBILE);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation/failed');
  });

  it('normalises kind aliases', () => {
    expect(canonicalDocumentType('Test Report')).toBe('lot_test_report');
    expect(canonicalDocumentType('coa')).toBe('certificate_of_analysis');
    expect(canonicalDocumentType('origin')).toBe('origin_declaration');
    expect(canonicalDocumentType('invoice')).toBeNull();
  });
});
