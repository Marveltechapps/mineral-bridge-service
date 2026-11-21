/**
 * Contact-change OTP SUCCESS + wrong-code paths — in-memory MongoDB only (no Atlas).
 */
import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const WEB = 'mineralbridge-web/0.1.0';
const PORT = 5041;

type StepRow = {
  step: string;
  status: 'PASS' | 'FAIL';
  detail: string;
};

const rows: StepRow[] = [];
function record(step: string, ok: boolean, detail: string) {
  rows.push({ step, status: ok ? 'PASS' : 'FAIL', detail: detail.slice(0, 320) });
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

async function webSignup(
  server: http.Server,
): Promise<{ accessToken: string; emailBefore: string; userId: string }> {
  const web = request(server);
  const email = `contact.iso.${Date.now()}@example.com`;
  const otpReq = await web.post('/v2/auth/otp/request').set('X-Client', WEB).send({
    intent: 'signup',
    channel: 'email',
    identifier: email,
    fullName: 'Contact Change Iso',
  });
  const devOtp = otpReq.body.developmentOtp as string;
  const challengeId = otpReq.body.challengeId as string;
  if (otpReq.status !== 202 || !devOtp || !challengeId) {
    throw new Error(`signup OTP failed HTTP ${otpReq.status}`);
  }
  const otpVerify = await web.post('/v2/auth/otp/verify').set('X-Client', WEB).send({
    challengeId,
    code: devOtp,
    keepSignedIn: true,
  });
  const regToken = otpVerify.body.registrationToken as string;
  if (otpVerify.status !== 200 || !regToken) throw new Error(`OTP verify failed HTTP ${otpVerify.status}`);

  const register = await web.post('/v2/auth/register').set('X-Client', WEB).send({
    registrationToken: regToken,
    fullName: 'Contact Change Iso',
    role: 'buyer',
    buyerType: 'refinery',
    countryCode: 'KE',
    acceptTerms: true,
    termsVersion: '2025-01',
  });
  const accessToken = register.body.accessToken as string;
  const userId = (register.body.me?.id ?? register.body.me?._id) as string | undefined;
  if (register.status !== 201 || !accessToken || !userId) {
    throw new Error(`register failed HTTP ${register.status}`);
  }
  return { accessToken, emailBefore: email, userId };
}

let repl: MongoMemoryReplSet | undefined;
let server: http.Server | undefined;
let emailBefore = '';
let emailAfterSuccess = '';
let emailAfterWrongPath = '';

try {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGODB_URI = repl.getUri('mb_contact_change_iso');
  process.env.NODE_ENV = 'development';
  process.env.DEV_OTP_ENABLED = 'true';
  process.env.PORT = String(PORT);
  process.env.HOST = '127.0.0.1';
  process.env.OTP_PROVIDER = 'fake';
  process.env.EMAIL_PROVIDER = 'fake';
  process.env.COOKIE_SECURE = 'false';
  process.env.CORS_WEB_ORIGINS = 'http://localhost:3000';
  process.env.LOG_LEVEL = 'warn';

  const { resetEnvCache } = await import('../src/config/env.js');
  resetEnvCache();
  const { connectDatabase } = await import('../src/config/database.js');
  await connectDatabase();

  ({ server } = await pickServer());
  record('1. Isolated API (in-memory)', true, `HTTP ready http://127.0.0.1:${PORT} DEV_OTP_ENABLED=true fake OTP`);

  const { accessToken, emailBefore: startEmail, userId } = await webSignup(server!);
  emailBefore = startEmail;
  record(
    '2. Register web customer',
    Boolean(accessToken),
    `X-Client=${WEB} emailBefore=${emailBefore}`,
  );

  const bearer = (r: request.Test) => r.set('Authorization', `Bearer ${accessToken}`).set('X-Client', WEB);

  const me0 = await bearer(request(server!).get('/v2/me'));
  const meEmail0 = (me0.body.email as string) ?? '';
  record(
    '3. GET /v2/me (baseline)',
    me0.status === 200 && meEmail0 === emailBefore,
    `HTTP ${me0.status} email=${meEmail0}`,
  );

  const newEmail1 = `new1.${Date.now()}@example.com`;
  const cc1 = await bearer(request(server!).post('/v2/me/contact-change')).send({
    channel: 'email',
    identifier: newEmail1,
  });
  const otp1 = cc1.body.developmentOtp as string | undefined;
  const ch1 = cc1.body.challengeId as string | undefined;
  record(
    '4. POST /v2/me/contact-change',
    cc1.status === 202 && Boolean(otp1 && ch1),
    `HTTP ${cc1.status} developmentOtp=${otp1 ? 'yes' : 'NO'} → ${newEmail1}`,
  );

  const v1 = await bearer(request(server!).post('/v2/me/contact-change/verify')).send({
    challengeId: ch1,
    code: otp1,
  });
  const verifiedEmail1 = (v1.body.email as string) ?? '';
  record(
    '5. POST contact-change/verify (correct)',
    v1.status === 200 && verifiedEmail1 === newEmail1,
    `HTTP ${v1.status} email=${verifiedEmail1}`,
  );

  const me1 = await bearer(request(server!).get('/v2/me'));
  emailAfterSuccess = (me1.body.email as string) ?? '';
  record(
    '6. GET /v2/me (after success)',
    me1.status === 200 && emailAfterSuccess === newEmail1,
    `HTTP ${me1.status} before=${emailBefore} after=${emailAfterSuccess}`,
  );

  const { UserModel } = await import('../src/modules/users/user.model.js');
  const doc = await UserModel.findById(userId).lean();
  const mongoEmail = (doc?.email as string) ?? '';
  record(
    '7. Mongo user.email',
    mongoEmail === newEmail1,
    `doc.email=${mongoEmail} expected=${newEmail1}`,
  );

  const newEmail2 = `new2.${Date.now()}@example.com`;
  const cc2 = await bearer(request(server!).post('/v2/me/contact-change')).send({
    channel: 'email',
    identifier: newEmail2,
  });
  const otp2 = cc2.body.developmentOtp as string | undefined;
  const ch2 = cc2.body.challengeId as string | undefined;
  record(
    '8. POST contact-change (wrong-code test)',
    cc2.status === 202 && Boolean(otp2 && ch2),
    `HTTP ${cc2.status} challenge for ${newEmail2}`,
  );

  const bad = await bearer(request(server!).post('/v2/me/contact-change/verify')).send({
    challengeId: ch2,
    code: '0000',
  });
  record(
    '9. POST verify wrong code',
    bad.status === 422,
    `HTTP ${bad.status} code=${(bad.body as { error?: { code?: string } }).error?.code ?? bad.body.error ?? '—'}`,
  );

  let chUse = ch2;
  let otpUse = otp2;
  if (bad.status === 422) {
    const ccFresh = await bearer(request(server!).post('/v2/me/contact-change')).send({
      channel: 'email',
      identifier: newEmail2,
    });
    chUse = ccFresh.body.challengeId;
    otpUse = ccFresh.body.developmentOtp;
    record(
      '10. Fresh contact-change after wrong code',
      ccFresh.status === 202 && Boolean(chUse && otpUse),
      `HTTP ${ccFresh.status} fresh challenge`,
    );
  } else {
    record('10. Fresh contact-change after wrong code', true, 'skipped — wrong code did not invalidate');
  }

  const v2 = await bearer(request(server!).post('/v2/me/contact-change/verify')).send({
    challengeId: chUse,
    code: otpUse,
  });
  emailAfterWrongPath = (v2.body.email as string) ?? '';
  record(
    '11. POST verify correct (after wrong)',
    v2.status === 200 && emailAfterWrongPath === newEmail2,
    `HTTP ${v2.status} email=${emailAfterWrongPath}`,
  );
} catch (e) {
  record('Unhandled error', false, e instanceof Error ? e.message : String(e));
} finally {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    record('12. Tear down server', true, 'closed');
  }
  try {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  try {
    await repl?.stop();
    record('13. Stop in-memory MongoDB', true, 'stopped');
  } catch {
    record('13. Stop in-memory MongoDB', false, 'stop failed');
  }
}

const required = [
  '1. Isolated API (in-memory)',
  '2. Register web customer',
  '4. POST /v2/me/contact-change',
  '5. POST contact-change/verify (correct)',
  '6. GET /v2/me (after success)',
  '9. POST verify wrong code',
];
const allRequiredPass = required.every((name) => rows.find((r) => r.step === name)?.status === 'PASS');

console.log('\n| Step | Status | Detail |');
console.log('|------|--------|--------|');
for (const r of rows) {
  console.log(`| ${r.step} | ${r.status} | ${r.detail.replace(/\|/g, '\\|')} |`);
}
console.log(`\nSummary: emailBefore=${emailBefore || '—'} → afterSuccess=${emailAfterSuccess || '—'} → afterWrongPath=${emailAfterWrongPath || '—'}`);
console.log(`\nOverall: ${allRequiredPass ? 'PASS' : 'FAIL'}\n`);
process.exit(allRequiredPass ? 0 : 1);