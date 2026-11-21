/**
 * MineralBridge WEB client buy-order path — in-memory only, never Atlas.
 * Prints a PASS/FAIL step table and exits 0 only if all required steps pass.
 */
import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const WEB = 'mineralbridge-web/0.1.0';
const PASSWORD = 'Correct-Horse-9!Battery';
const PORT = 5023;
const CEO_EMAIL = 'ceo@mineralbridge.test';
const LOT_REF = 'LOT-WEB-ISO-1';

type StepRow = { step: string; status: 'PASS' | 'FAIL'; detail: string };

const rows: StepRow[] = [];
function record(step: string, ok: boolean, detail: string) {
  rows.push({ step, status: ok ? 'PASS' : 'FAIL', detail: detail.slice(0, 240) });
}

function pickServer(): Promise<{ server: http.Server; app: Express }> {
  return new Promise((resolve, reject) => {
    import('../src/app.js')
      .then(({ createApp }) => {
        const app = createApp();
        const server = app.listen(PORT, '127.0.0.1', () => resolve({ server, app }));
        server.on('error', reject);
      })
      .catch(reject);
  });
}

async function uploadKyc(
  agent: { post(path: string): request.Test },
  token: string,
  filename: string,
): Promise<string | null> {
  const res = await agent
    .post('/v2/files')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Client', WEB)
    .field('purpose', 'kyc')
    .attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), filename);
  if (res.status !== 201) return null;
  return (res.body.fileId ?? res.body.id) as string | undefined ?? null;
}

let repl: MongoMemoryReplSet | undefined;
let server: http.Server | undefined;

try {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGODB_URI = repl.getUri('mb_web_buy_iso');
  process.env.NODE_ENV = 'development';
  process.env.DEV_OTP_ENABLED = 'true';
  process.env.PORT = String(PORT);
  process.env.HOST = '127.0.0.1';
  process.env.OTP_PROVIDER = 'fake';
  process.env.EMAIL_PROVIDER = 'fake';
  process.env.COOKIE_SECURE = 'false';
  process.env.CORS_WEB_ORIGINS = 'http://localhost:3000';
  process.env.CORS_ADMIN_ORIGINS = 'http://127.0.0.1:5173,http://localhost:5173';
  process.env.LOG_LEVEL = 'warn';

  const { resetEnvCache } = await import('../src/config/env.js');
  resetEnvCache();
  const { connectDatabase } = await import('../src/config/database.js');
  await connectDatabase();

  const { createStaff } = await import('../src/modules/staff/staff.service.js');
  await createStaff({ email: CEO_EMAIL, password: PASSWORD, name: 'Platform CEO', roleId: 'ROLE-CEO' });

  const { ProductModel } = await import('../src/models/catalog.model.js');
  await ProductModel.create({
    reference: LOT_REF,
    name: 'Web Iso Gold',
    typeSlug: 'gold',
    categorySlug: 'precious',
    mineralCode: 'AU',
    origin: { country: 'KE' },
    status: 'active',
    availableGrams: 50_000,
    minOrderGrams: 100,
    unitPriceMinorE4PerGram: 10_000,
    seller: { name: 'Mineral Bridge', tier: 'mineral_bridge', verified: true },
    attributes: {},
  });

  ({ server } = await pickServer());
  record('Isolated server (in-memory)', true, `http://127.0.0.1:${PORT}`);

  const adminAgent = request.agent(server!);
  const sign = await adminAgent.post('/v2/admin/auth/sign-in').set('X-Client', 'admin').send({
    email: CEO_EMAIL,
    password: PASSWORD,
  });
  const csrf = String(sign.headers['x-csrf-token'] || '');
  record('Admin sign-in (CEO)', sign.status === 200, `HTTP ${sign.status}`);

  const email = `web.buy.${Date.now()}@example.com`;
  const web = request(server!);
  const otpReq = await web
    .post('/v2/auth/otp/request')
    .set('X-Client', WEB)
    .send({ intent: 'signup', channel: 'email', identifier: email, fullName: 'Web Buyer Iso' });
  const devOtp = otpReq.body.developmentOtp as string | undefined;
  const challengeId = otpReq.body.challengeId as string | undefined;
  record(
    'OTP request (signup)',
    otpReq.status === 202 && Boolean(devOtp && challengeId),
    `HTTP ${otpReq.status}${devOtp ? '' : ' — no developmentOtp'}`,
  );

  const otpVerify = await web
    .post('/v2/auth/otp/verify')
    .set('X-Client', WEB)
    .send({ challengeId, code: devOtp, keepSignedIn: true });
  const regToken = otpVerify.body.registrationToken as string | undefined;
  record(
    'OTP verify → registration token',
    otpVerify.status === 200 && otpVerify.body.status === 'needs_registration' && Boolean(regToken),
    `HTTP ${otpVerify.status} status=${otpVerify.body.status}`,
  );

  const register = await web
    .post('/v2/auth/register')
    .set('X-Client', WEB)
    .send({
      registrationToken: regToken,
      fullName: 'Web Buyer Iso',
      role: 'buyer',
      buyerType: 'refinery',
      countryCode: 'KE',
      acceptTerms: true,
      termsVersion: '2025-01',
    });
  const accessToken = register.body.accessToken as string | undefined;
  record('Register buyer (web)', register.status === 201 && Boolean(accessToken), `HTTP ${register.status}`);

  const bearer = (r: request.Test) => r.set('Authorization', `Bearer ${accessToken}`).set('X-Client', WEB);

  const kycAgent = request.agent(server!);
  await bearer(kycAgent.patch('/v2/kyc')).send({ idType: 'passport', consent: true });
  const fFront = await uploadKyc(kycAgent, accessToken!, 'passport.jpg');
  const fSelfie = await uploadKyc(kycAgent, accessToken!, 'selfie.jpg');
  const fAddr = await uploadKyc(kycAgent, accessToken!, 'address.pdf');
  const docsOk = Boolean(fFront && fSelfie && fAddr);
  record('Upload KYC documents (3)', docsOk, docsOk ? `fileIds ok` : `upload failed`);

  if (fFront) await bearer(kycAgent.put('/v2/kyc/documents/id_front')).send({ fileId: fFront });
  if (fSelfie) await bearer(kycAgent.put('/v2/kyc/documents/selfie')).send({ fileId: fSelfie });
  if (fAddr) await bearer(kycAgent.put('/v2/kyc/documents/proof_of_address')).send({ fileId: fAddr });

  const kycSubmit = await bearer(kycAgent.post('/v2/kyc/submit')).send({ consent: true });
  record('KYC submit', kycSubmit.status === 202 && kycSubmit.body.status === 'pending', `HTTP ${kycSubmit.status}`);

  const kycList = await adminAgent.get('/v2/admin/kyc').set('X-Client', 'admin').set('X-CSRF-Token', csrf);
  const submission = (kycList.body.items || []).find(
    (k: { reference?: string }) => k.reference === kycSubmit.body.reference,
  ) as { _id?: string; id?: string } | undefined;
  const submissionId = submission?._id ?? submission?.id;
  const kycDecide = submissionId
    ? await adminAgent
        .post(`/v2/admin/kyc/${submissionId}/decide`)
        .set('X-Client', 'admin')
        .set('X-CSRF-Token', csrf)
        .send({ decision: 'verified' })
    : { status: 0, body: { error: 'no submission in admin queue' } };
  record(
    'Admin KYC approve',
    kycDecide.status === 200,
    `HTTP ${kycDecide.status} ${kycDecide.body.status ?? kycDecide.body.decision ?? ''}`,
  );

  const cartPut = await bearer(web.put(`/v2/cart/items/${LOT_REF}`)).send({ qty: { value: 100, unit: 'g' } });
  record('PUT cart item', cartPut.status === 200 && cartPut.body.count >= 1, `HTTP ${cartPut.status}`);

  const order = await bearer(web.post('/v2/orders'))
    .set('Idempotency-Key', `web-iso-buy-${Date.now()}`)
    .send({
      kind: 'buy',
      fromCart: true,
      delivery: {
        org: 'Iso Refinery',
        street: '12 Industrial Ave',
        city: 'Nairobi',
        region: 'Nairobi',
        country: 'KE',
        contact: 'Web Buyer Iso',
        mobile: '+254711990001',
      },
    });
  const orderRef = order.body.reference as string | undefined;
  record(
    'POST /v2/orders buy fromCart',
    order.status === 201 && Boolean(orderRef),
    `HTTP ${order.status} ref=${orderRef ?? order.body.error?.code ?? '—'}`,
  );

  let quoteAdvanced = false;
  let acceptQuotation: { status: number; body: Record<string, unknown> } = { status: 0, body: {} };
  if (orderRef) {
    const admOrder = await adminAgent
      .get(`/v2/admin/orders/${encodeURIComponent(orderRef)}`)
      .set('X-Client', 'admin')
      .set('X-CSRF-Token', csrf);
    const ver = Number(admOrder.body.version ?? 0);
    const stepKey = admOrder.body.workflow?.stepKey ?? 'accepted';
    const toQuote = await adminAgent
      .post(`/v2/admin/orders/${encodeURIComponent(orderRef)}/steps/${stepKey}`)
      .set('X-Client', 'admin')
      .set('X-CSRF-Token', csrf)
      .send({ version: ver });
    const adm2 = await adminAgent
      .get(`/v2/admin/orders/${encodeURIComponent(orderRef)}`)
      .set('X-Client', 'admin')
      .set('X-CSRF-Token', csrf);
    const ver2 = Number(adm2.body.version ?? ver);
    const step2 = adm2.body.workflow?.stepKey ?? 'quote';
    const quote = await adminAgent
      .post(`/v2/admin/orders/${encodeURIComponent(orderRef)}/steps/${step2}`)
      .set('X-Client', 'admin')
      .set('X-CSRF-Token', csrf)
      .send({
        version: ver2,
        data: { lines: [{ productRef: LOT_REF, amountMinor: 500_000 }], feeMinor: 0, validDays: 7 },
      });
    quoteAdvanced = quote.status === 200 && (quote.body.workflow?.stepKey === 'quoteOk' || step2 === 'quoteOk');
    record(
      'Admin advance quote → quoteOk',
      quoteAdvanced,
      `advance1=${toQuote.status} quote=${quote.status} step=${quote.body.workflow?.stepKey ?? '—'}`,
    );

    const detail = await bearer(web.get(`/v2/orders/${encodeURIComponent(orderRef)}`));
    const quotation = detail.body.quotation ?? detail.body.quote ?? detail.body.pricing?.quotation;
    const quotationNumber = quotation?.number ?? quotation?.quotationNumber;
    const oVer = Number(detail.body.version ?? 0);
    if (quotationNumber) {
      const res = await bearer(web.post(`/v2/orders/${encodeURIComponent(orderRef)}/quotation/accept`)).send({
        quotationNumber,
        version: oVer,
      });
      acceptQuotation = { status: res.status, body: res.body };
    }
    record(
      'Customer accept quotation',
      acceptQuotation.status === 200,
      quotationNumber
        ? `HTTP ${acceptQuotation.status}`
        : `skipped — no quotation on order (GET ${detail.status})`,
    );
  } else {
    record('Admin advance quote → quoteOk', false, 'skipped — no order ref');
    record('Customer accept quotation', false, 'skipped — no order ref');
  }
} catch (e) {
  record('Unhandled error', false, e instanceof Error ? e.message : String(e));
} finally {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    record('Tear down server', true, 'closed');
  }
  try {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  try {
    await repl?.stop();
    record('Stop in-memory MongoDB', true, 'stopped');
  } catch {
    record('Stop in-memory MongoDB', false, 'stop failed');
  }
}

const required = [
  'Isolated server (in-memory)',
  'OTP request (signup)',
  'OTP verify → registration token',
  'Register buyer (web)',
  'POST /v2/orders buy fromCart',
];
const allRequiredPass = required.every((name) => rows.find((r) => r.step === name)?.status === 'PASS');

console.log('\n| Step | Status | Detail |');
console.log('|------|--------|--------|');
for (const r of rows) {
  console.log(`| ${r.step} | ${r.status} | ${r.detail.replace(/\|/g, '\\|')} |`);
}
console.log(`\nOverall: ${allRequiredPass ? 'PASS' : 'FAIL'}\n`);
process.exit(allRequiredPass ? 0 : 1);