/**
 * Dashboard + Web + Mobile against one in-memory MongoDB replica (port 5051).
 * Never writes to Atlas. Prints PASS/FAIL table; exit 0 only if required steps pass.
 */
import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const WEB = 'mineralbridge-web/0.1.0';
const MOBILE = 'mineralbridge-mobile/0.1.0';
const PASSWORD = 'Correct-Horse-9!Battery';
const PORT = 5051;
const CEO_EMAIL = 'ceo@mineralbridge.test';

type StepRow = { step: string; status: 'PASS' | 'FAIL'; detail: string; client?: string };
const rows: StepRow[] = [];

function record(step: string, ok: boolean, detail: string, client?: string) {
  rows.push({ step, status: ok ? 'PASS' : 'FAIL', detail: detail.slice(0, 280), client });
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

async function uploadKyc(agent: request.SuperAgentTest, token: string, client: string, filename: string): Promise<string | null> {
  const res = await agent
    .post('/v2/files')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Client', client)
    .field('purpose', 'kyc')
    .attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), filename);
  if (res.status !== 201) return null;
  return (res.body.fileId ?? res.body.id) as string | undefined ?? null;
}

let repl: MongoMemoryReplSet | undefined;
let server: http.Server | undefined;

let adminLotRef = '';
let webOrderRef = '';
let webUserId = '';
let webCustomerNo = '';
let webAccessToken = '';
let adminCsrf = '';

try {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGODB_URI = repl.getUri('mb_three_clients_5051');
  process.env.NODE_ENV = 'development';
  process.env.DEV_OTP_ENABLED = 'true';
  process.env.PORT = String(PORT);
  process.env.HOST = '127.0.0.1';
  process.env.OTP_PROVIDER = 'fake';
  process.env.EMAIL_PROVIDER = 'fake';
  process.env.COOKIE_SECURE = 'false';
  process.env.CORS_WEB_ORIGINS = 'http://localhost:3000,http://localhost:5173';
  process.env.CORS_ADMIN_ORIGINS = 'http://localhost:5173,http://127.0.0.1:5173';
  process.env.CORS_MOBILE_ORIGINS = '*';
  process.env.LOG_LEVEL = 'warn';

  const { resetEnvCache } = await import('../src/config/env.js');
  resetEnvCache();
  const { connectDatabase } = await import('../src/config/database.js');
  await connectDatabase();

  const { createStaff } = await import('../src/modules/staff/staff.service.js');
  await createStaff({ email: CEO_EMAIL, password: PASSWORD, name: 'Platform CEO', roleId: 'ROLE-CEO' });

  ({ server } = await pickServer());
  record('1. Isolated API (in-memory :5051)', true, `DEV_OTP fake providers CORS 3000+5173`, 'shared');

  const api = request(server!);
  const corsProbe = await api
    .options('/v2/health')
    .set('Origin', 'http://localhost:3000')
    .set('Access-Control-Request-Method', 'GET')
    .set('X-Client', WEB);
  const acao = String(corsProbe.headers['access-control-allow-origin'] ?? '');
  record(
    '1b. CORS preflight (web origin)',
    corsProbe.status === 204 && (acao === 'http://localhost:3000' || acao === '*'),
    `HTTP ${corsProbe.status} allow-origin=${acao || '—'}`,
    'shared',
  );

  const adminAgent = request.agent(server!);
  const sign = await adminAgent.post('/v2/admin/auth/sign-in').set('X-Client', 'admin').send({
    email: CEO_EMAIL,
    password: PASSWORD,
  });
  adminCsrf = String(sign.headers['x-csrf-token'] || '');
  record('3. Admin sign-in (X-Client: admin)', sign.status === 200 && Boolean(adminCsrf), `HTTP ${sign.status}`, 'admin');

  const adminCustomer = await adminAgent
    .post('/v2/admin/customers')
    .set('X-Client', 'admin')
    .set('X-CSRF-Token', adminCsrf)
    .send({
      fullName: 'Admin Created Prospect',
      email: `prospect.${Date.now()}@example.com`,
      countryCode: 'KE',
      businessName: 'Prospect Ltd',
      role: 'buyer',
    });
  record(
    '3b. Admin create customer',
    adminCustomer.status === 201 && Boolean(adminCustomer.body.customerNo),
    `HTTP ${adminCustomer.status} ${adminCustomer.body.customerNo ?? ''}`,
    'admin',
  );

  const lotDraft = await adminAgent.post('/v2/admin/catalogue/lots').set('X-Client', 'admin').set('X-CSRF-Token', adminCsrf).send({
    name: 'Shared State Gold',
    mineral: 'gold',
    unit: 'kg',
    avail: 50,
    origin: 'Nairobi · Kenya',
    grade: 'Au 99.5%',
    form: 'Bar',
  });
  adminLotRef = lotDraft.body.reference as string;
  const lotListed = adminLotRef
    ? await adminAgent
        .patch(`/v2/admin/catalogue/lots/${adminLotRef}`)
        .set('X-Client', 'admin')
        .set('X-CSRF-Token', adminCsrf)
        .send({ status: 'listed', referencePrice: 65, minOrder: 0.1, unit: 'kg' })
    : { status: 0, body: {} };
  record(
    '3c. Admin create + list lot',
    lotDraft.status === 201 && lotListed.status === 200 && lotListed.body.status === 'active',
    `create=${lotDraft.status} ref=${adminLotRef || '—'} list=${lotListed.status}`,
    'admin',
  );

  const email = `shared.buyer.${Date.now()}@example.com`;
  const web = request(server!);
  const otpReq = await web.post('/v2/auth/otp/request').set('X-Client', WEB).send({
    intent: 'signup',
    channel: 'email',
    identifier: email,
    fullName: 'Shared Web Buyer',
  });
  const devOtp = otpReq.body.developmentOtp as string | undefined;
  const challengeId = otpReq.body.challengeId as string | undefined;
  record('4a. Web OTP request (signup)', otpReq.status === 202 && Boolean(devOtp && challengeId), `HTTP ${otpReq.status}`, 'web');

  const otpVerify = await web
    .post('/v2/auth/otp/verify')
    .set('X-Client', WEB)
    .send({ challengeId, code: devOtp, keepSignedIn: true });
  const regToken = otpVerify.body.registrationToken as string | undefined;
  record('4b. Web OTP verify', otpVerify.status === 200 && Boolean(regToken), `HTTP ${otpVerify.status}`, 'web');

  const register = await web.post('/v2/auth/register').set('X-Client', WEB).send({
    registrationToken: regToken,
    fullName: 'Shared Web Buyer',
    role: 'buyer',
    buyerType: 'refinery',
    countryCode: 'KE',
    acceptTerms: true,
    termsVersion: '2025-01',
  });
  webAccessToken = register.body.accessToken as string;
  const me = register.body.me as { id?: string; customerNo?: string; fullName?: string } | undefined;
  webUserId = me?.id ?? '';
  webCustomerNo = me?.customerNo ?? '';
  record(
    '4c. Web register',
    register.status === 201 && Boolean(webAccessToken && webCustomerNo),
    `HTTP ${register.status} ${webCustomerNo} userId=${webUserId ? 'ok' : '—'}`,
    'web',
  );

  const webBearer = (r: request.Test) => r.set('Authorization', `Bearer ${webAccessToken}`).set('X-Client', WEB);
  const kycAgent = request.agent(server!);
  await webBearer(kycAgent.patch('/v2/kyc')).send({ idType: 'passport', consent: true });
  const fFront = await uploadKyc(kycAgent, webAccessToken, WEB, 'passport.jpg');
  const fSelfie = await uploadKyc(kycAgent, webAccessToken, WEB, 'selfie.jpg');
  const fAddr = await uploadKyc(kycAgent, webAccessToken, WEB, 'address.pdf');
  if (fFront) await webBearer(kycAgent.put('/v2/kyc/documents/id_front')).send({ fileId: fFront });
  if (fSelfie) await webBearer(kycAgent.put('/v2/kyc/documents/selfie')).send({ fileId: fSelfie });
  if (fAddr) await webBearer(kycAgent.put('/v2/kyc/documents/proof_of_address')).send({ fileId: fAddr });
  const kycSubmit = await webBearer(kycAgent.post('/v2/kyc/submit')).send({ consent: true });
  record('4d. Web KYC submit', kycSubmit.status === 202, `HTTP ${kycSubmit.status}`, 'web');

  const kycList = await adminAgent.get('/v2/admin/kyc').set('X-Client', 'admin').set('X-CSRF-Token', adminCsrf);
  const submission = (kycList.body.items || []).find(
    (k: { reference?: string }) => k.reference === kycSubmit.body.reference,
  ) as { _id?: string; id?: string } | undefined;
  const submissionId = submission?._id ?? submission?.id;
  const kycDecide = submissionId
    ? await adminAgent
        .post(`/v2/admin/kyc/${submissionId}/decide`)
        .set('X-Client', 'admin')
        .set('X-CSRF-Token', adminCsrf)
        .send({ decision: 'verified' })
    : { status: 0, body: {} };
  record('4e. Admin KYC approve (shared DB)', kycDecide.status === 200, `HTTP ${kycDecide.status}`, 'admin→web');

  const supportCreate = webUserId
    ? await adminAgent
        .post('/v2/admin/support')
        .set('X-Client', 'admin')
        .set('X-CSRF-Token', adminCsrf)
        .send({
          customerId: webUserId,
          topic: 'order',
          subject: 'Welcome',
          body: 'Support thread for shared-state verification.',
        })
    : { status: 0, body: {} };
  record(
    '3d. Admin support thread (web customer)',
    supportCreate.status === 201 && Boolean(supportCreate.body.reference),
    `HTTP ${supportCreate.status} ${supportCreate.body.reference ?? ''}`,
    'admin',
  );

  if (adminLotRef) {
    const cartPut = await webBearer(web.put(`/v2/cart/items/${adminLotRef}`)).send({ qty: { value: 100, unit: 'g' } });
    record('4f. Web cart add admin lot', cartPut.status === 200, `HTTP ${cartPut.status}`, 'web');

    const order = await webBearer(web.post('/v2/orders'))
      .set('Idempotency-Key', `shared-iso-${Date.now()}`)
      .send({
        kind: 'buy',
        fromCart: true,
        delivery: {
          org: 'Shared Refinery',
          street: '1 Shared Ave',
          city: 'Nairobi',
          region: 'Nairobi',
          country: 'KE',
          contact: 'Shared Web Buyer',
          mobile: '+254711880001',
        },
      });
    webOrderRef = order.body.reference as string;
    record(
      '4g. Web buy order from cart',
      order.status === 201 && Boolean(webOrderRef),
      `HTTP ${order.status} ref=${webOrderRef ?? '—'}`,
      'web',
    );
  } else {
    record('4f. Web cart add admin lot', false, 'skipped — no admin lot ref', 'web');
    record('4g. Web buy order from cart', false, 'skipped', 'web');
  }

  const mobOtpReq = await web.post('/v2/auth/otp/request').set('X-Client', MOBILE).send({
    intent: 'signin',
    channel: 'email',
    identifier: email,
  });
  const mobOtp = mobOtpReq.body.developmentOtp as string | undefined;
  const mobChallenge = mobOtpReq.body.challengeId as string | undefined;
  const mobVerify = await web
    .post('/v2/auth/otp/verify')
    .set('X-Client', MOBILE)
    .send({ challengeId: mobChallenge, code: mobOtp, keepSignedIn: true });
  const mobToken = (mobVerify.body.accessToken || mobVerify.body.tokens?.accessToken) as string | undefined;
  record(
    '5a. Mobile sign-in same user',
    mobVerify.status === 200 && Boolean(mobToken),
    `HTTP ${mobVerify.status}`,
    'mobile',
  );

  const mobBearer = (r: request.Test) => r.set('Authorization', `Bearer ${mobToken}`).set('X-Client', MOBILE);
  const catalogue = mobToken ? await mobBearer(web.get('/v2/catalogue/products')).query({ limit: 50 }) : { status: 0, body: { items: [] } };
  const items = (catalogue.body.items ?? catalogue.body.products ?? []) as { ref?: string; reference?: string; name?: string }[];
  const sawLot = adminLotRef
    ? items.some((p) => (p.ref ?? p.reference) === adminLotRef || p.name === 'Shared State Gold')
    : false;
  record(
    '5b. Mobile catalogue sees admin lot',
    catalogue.status === 200 && sawLot,
    `HTTP ${catalogue.status} items=${items.length} sawRef=${sawLot}`,
    'mobile',
  );

  const mobOrders = mobToken
    ? await mobBearer(web.get('/v2/orders')).query(webOrderRef ? { kind: 'buy' } : {})
    : { status: 0, body: { items: [] } };
  const orderRefs = ((mobOrders.body.items ?? []) as { ref?: string; reference?: string }[]).map(
    (o) => o.ref ?? o.reference,
  );
  const sawOrder = webOrderRef ? orderRefs.includes(webOrderRef) : false;
  record(
    '5c. Mobile orders list (web order)',
    mobOrders.status === 200 && sawOrder,
    `HTTP ${mobOrders.status} refs=${orderRefs.slice(0, 3).join(',')}`,
    'mobile',
  );

  const consoleSnap = await adminAgent.get('/v2/admin/console?page=1&pageSize=50').set('X-Client', 'admin').set('X-CSRF-Token', adminCsrf);
  const consoleOrders = (consoleSnap.body.orders ?? []) as { id: string }[];
  const consoleCustomers = (consoleSnap.body.customers ?? []) as { id: string; name?: string }[];
  const hasOrder = webOrderRef ? consoleOrders.some((o) => o.id === webOrderRef) : false;
  const hasCustomer = webCustomerNo
    ? consoleCustomers.some(
        (c) => c.id === webCustomerNo || (c as { name?: string }).name === 'Shared Web Buyer',
      )
    : false;
  record(
    '6. Admin console sees web order + customer',
    consoleSnap.status === 200 && hasOrder && hasCustomer,
    `HTTP ${consoleSnap.status} order=${hasOrder} customer=${hasCustomer} live=${consoleSnap.body.live}`,
    'admin',
  );

  let customerOpenOk = false;
  let customerAllNote = '';
  if (webOrderRef) {
    const del = await adminAgent
      .delete(`/v2/admin/orders/${encodeURIComponent(webOrderRef)}`)
      .set('X-Client', 'admin')
      .set('X-CSRF-Token', adminCsrf)
      .send({ reason: 'Shared-state test removal' });
    record('7a. Admin soft-delete order', del.status === 200 && del.body.deleted === true, `HTTP ${del.status}`, 'admin');

    const webOpen = await webBearer(web.get('/v2/orders')).query({ state: 'open', kind: 'buy' });
    const openRefs = ((webOpen.body.items ?? []) as { ref?: string; reference?: string }[]).map((o) => o.ref ?? o.reference);
    customerOpenOk = !openRefs.includes(webOrderRef);
    const webAll = await webBearer(web.get('/v2/orders')).query({ kind: 'buy' });
    const allRefs = ((webAll.body.items ?? []) as { ref?: string; reference?: string; status?: string }[]).map(
      (o) => `${o.ref ?? o.reference}:${o.status ?? '?'}`,
    );
    const stillInAll = allRefs.some((s) => s.startsWith(`${webOrderRef}:`));
    customerAllNote = stillInAll ? `still in unfiltered list (${allRefs.find((s) => s.startsWith(webOrderRef))})` : 'absent from unfiltered list';
    record(
      '7b. Customer orders open list hides deleted',
      customerOpenOk,
      customerOpenOk
        ? `open list ok; ${customerAllNote}`
        : `still visible in state=open; ${customerAllNote}`,
      'web',
    );

    const consoleAfter = await adminAgent.get('/v2/admin/console').set('X-Client', 'admin').set('X-CSRF-Token', adminCsrf);
    const adminGone = !(consoleAfter.body.orders ?? []).some((o: { id: string }) => o.id === webOrderRef);
    record('7c. Admin console hides soft-deleted order', adminGone, `orderInConsole=${!adminGone}`, 'admin');
  } else {
    record('7a. Admin soft-delete order', false, 'skipped — no order ref', 'admin');
    record('7b. Customer orders open list hides deleted', false, 'skipped', 'web');
    record('7c. Admin console hides soft-deleted order', false, 'skipped', 'admin');
  }

  const catSlug = `iso-cat-${Date.now().toString(36)}`;
  const catCreate = await adminAgent
    .post('/v2/admin/catalogue/categories')
    .set('X-Client', 'admin')
    .set('X-CSRF-Token', adminCsrf)
    .send({ name: `ISO Category ${catSlug}`, slug: catSlug, description: 'Three-client proof category' });
  const catTree = await adminAgent
    .get('/v2/admin/catalogue/tree')
    .set('X-Client', 'admin')
    .set('X-CSRF-Token', adminCsrf);
  const treeItems = (catTree.body.items ?? []) as { slug: string }[];
  const catRead = treeItems.some((c) => c.slug === catSlug);
  record(
    '8. Categories API write + read',
    catCreate.status === 201 && catTree.status === 200 && catRead,
    `POST=${catCreate.status} slug=${catSlug} readBack=${catRead}`,
    'admin',
  );
} catch (e) {
  record('Unhandled error', false, e instanceof Error ? e.message : String(e), 'shared');
} finally {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    record('9. Tear down server', true, 'closed', 'shared');
  }
  try {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  try {
    await repl?.stop();
    record('9b. Stop in-memory MongoDB', true, 'stopped', 'shared');
  } catch {
    record('9b. Stop in-memory MongoDB', false, 'stop failed', 'shared');
  }
}

const summaryRows = [
  { area: '1 API + CORS', keys: ['1. Isolated API (in-memory :5051)', '1b. CORS preflight (web origin)'] },
  { area: '3 Admin (X-Client: admin)', keys: ['3. Admin sign-in (X-Client: admin)', '3b. Admin create customer', '3c. Admin create + list lot', '3d. Admin support thread (web customer)'] },
  { area: '4 Web (mineralbridge-web)', keys: ['4a. Web OTP request (signup)', '4b. Web OTP verify', '4c. Web register', '4d. Web KYC submit', '4e. Admin KYC approve (shared DB)', '4f. Web cart add admin lot', '4g. Web buy order from cart'] },
  { area: '5 Mobile (mineralbridge-mobile)', keys: ['5a. Mobile sign-in same user', '5b. Mobile catalogue sees admin lot', '5c. Mobile orders list (web order)'] },
  { area: '6 Admin console snapshot', keys: ['6. Admin console sees web order + customer'] },
  { area: '7 Soft delete + visibility', keys: ['7a. Admin soft-delete order', '7b. Customer orders open list hides deleted', '7c. Admin console hides soft-deleted order'] },
  { area: '8 New write API', keys: ['8. Categories API write + read'] },
  { area: '9 Teardown', keys: ['9. Tear down server', '9b. Stop in-memory MongoDB'] },
];

console.log('\n## Shared MongoDB state — Dashboard / Web / Mobile (port 5051)\n');
console.log('| Step | Client | Status | Detail |');
console.log('|------|--------|--------|--------|');
for (const r of rows) {
  const client = r.client ?? '—';
  console.log(`| ${r.step} | ${client} | ${r.status} | ${r.detail.replace(/\|/g, '\\|')} |`);
}

console.log('\n### Area summary\n');
console.log('| Area | Result |');
console.log('|------|--------|');
for (const { area, keys } of summaryRows) {
  const statuses = keys.map((k) => rows.find((r) => r.step === k)?.status ?? 'FAIL');
  const result = statuses.every((s) => s === 'PASS') ? 'PASS' : statuses.some((s) => s === 'PASS') ? 'PARTIAL' : 'FAIL';
  const failKeys = keys.filter((k, i) => statuses[i] !== 'PASS');
  console.log(`| ${area} | ${result}${failKeys.length ? ` (${failKeys.join('; ')})` : ''} |`);
}

const critical = [
  '1. Isolated API (in-memory :5051)',
  '3. Admin sign-in (X-Client: admin)',
  '3c. Admin create + list lot',
  '4g. Web buy order from cart',
  '5b. Mobile catalogue sees admin lot',
  '5c. Mobile orders list (web order)',
  '6. Admin console sees web order + customer',
  '8. Categories API write + read',
];
const overall = critical.every((k) => rows.find((r) => r.step === k)?.status === 'PASS');
console.log(`\n**Overall shared-state proof: ${overall ? 'PASS' : 'FAIL'}** (no Atlas writes)\n`);
process.exit(overall ? 0 : 1);