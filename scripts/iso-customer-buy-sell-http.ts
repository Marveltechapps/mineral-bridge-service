/**
 * Customer + admin buy/sell walk against the isolated API on :5011.
 * Uses developmentOtp (isolated server must set DEV_OTP_ENABLED).
 * Never talks to Atlas.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:5011';
const tmp = os.tmpdir();
const jarAdmin = path.join(tmp, 'mb-iso-cust-admin.txt');
const jarCust = path.join(tmp, 'mb-iso-cust-user.txt');
const csrfAdmin = path.join(tmp, 'mb-iso-cust-csrf-admin.txt');
writeFileSync(jarAdmin, '');
writeFileSync(jarCust, '');
writeFileSync(csrfAdmin, '');

function curl(args: string[]) {
  const res = spawnSync('curl.exe', ['-sS', ...args], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`curl failed: ${res.stderr || res.stdout}`);
  return res.stdout || '';
}

function admin(method: string, urlPath: string, body?: unknown) {
  const headersOut = path.join(tmp, 'mb-iso-h.txt');
  const bodyOut = path.join(tmp, 'mb-iso-b.json');
  const args = ['-b', jarAdmin, '-c', jarAdmin, '-H', 'X-Client: admin', '-H', 'Accept: application/json', '-D', headersOut, '-o', bodyOut, '-w', '%{http_code}'];
  if (method !== 'GET') {
    args.push('-X', method, '-H', 'Content-Type: application/json');
    const csrf = readFileSync(csrfAdmin, 'utf8').trim();
    if (csrf) args.push('-H', `X-CSRF-Token: ${csrf}`);
  }
  if (body !== undefined) {
    const f = path.join(tmp, 'mb-iso-req.json');
    writeFileSync(f, JSON.stringify(body));
    args.push('--data-binary', `@${f}`);
  }
  args.push(`${BASE}${urlPath}`);
  const code = Number(curl(args).trim());
  const headers = readFileSync(headersOut, 'utf8');
  const m = /x-csrf-token:\s*(.+)/i.exec(headers);
  if (m) writeFileSync(csrfAdmin, m[1]!.trim());
  const json = JSON.parse(readFileSync(bodyOut, 'utf8') || '{}');
  return { code, json };
}

function cust(method: string, urlPath: string, body?: unknown, token?: string) {
  const bodyOut = path.join(tmp, 'mb-iso-cb.json');
  const args = ['-o', bodyOut, '-w', '%{http_code}', '-H', 'X-Client: mineralbridge-mobile/0.1.0', '-H', 'Accept: application/json'];
  if (token) args.push('-H', `Authorization: Bearer ${token}`);
  if (method !== 'GET') {
    args.push('-X', method, '-H', 'Content-Type: application/json');
  }
  if (body !== undefined) {
    const f = path.join(tmp, 'mb-iso-creq.json');
    writeFileSync(f, JSON.stringify(body));
    args.push('--data-binary', `@${f}`);
  }
  args.push(`${BASE}${urlPath}`);
  const code = Number(curl(args).trim());
  const json = JSON.parse(readFileSync(bodyOut, 'utf8') || '{}');
  return { code, json };
}

const sign = admin('POST', '/v2/admin/auth/sign-in', {
  email: 'ceo@mineralbridge.test',
  password: 'Correct-Horse-9!Battery',
});
if (sign.code !== 200) throw new Error(`admin sign-in ${sign.code} ${JSON.stringify(sign.json)}`);

const otp = cust('POST', '/v2/auth/otp/request', {
  intent: 'signin',
  channel: 'email',
  identifier: 'isolated.seller@example.com',
});
const developmentOtp = otp.json.developmentOtp as string | undefined;
const challengeId = otp.json.challengeId as string | undefined;
if (!developmentOtp || !challengeId) {
  console.log(JSON.stringify({ step: 'otp', otp }, null, 2));
  throw new Error('developmentOtp missing — isolated server must set DEV_OTP_ENABLED=true under development');
}
const verified = cust('POST', '/v2/auth/otp/verify', { challengeId, code: developmentOtp });
const accessToken = (verified.json.accessToken || verified.json.tokens?.accessToken) as string | undefined;
if (!accessToken) {
  console.log(JSON.stringify({ step: 'verify', verified }, null, 2));
  throw new Error('no access token');
}

const sell = admin('GET', '/v2/admin/orders/MB-ORD-ISO-SELL');
const buy = admin('GET', '/v2/admin/orders/MB-ORD-ISO-1');
let acceptSell: { code: number; json: Record<string, unknown> } = {
  code: 0,
  json: { skipped: true, step: sell.json.workflow?.stepKey },
};
if (sell.json.workflow?.stepKey === 'quoteOk') {
  const detail = cust('GET', `/v2/orders/${encodeURIComponent(sell.json.reference || 'MB-ORD-ISO-SELL')}`, undefined, accessToken);
  const q = detail.json.quotation || detail.json.quote || detail.json.pricing?.quotation;
  const quotationNumber = q?.number || q?.quotationNumber;
  const version = Number(detail.json.version ?? sell.json.version ?? 0);
  if (!quotationNumber) {
    acceptSell = { code: detail.code, json: { error: 'no quotation on customer order', detail: detail.json } };
  } else {
    acceptSell = cust(
      'POST',
      `/v2/orders/${encodeURIComponent(sell.json.reference || 'MB-ORD-ISO-SELL')}/quotation/accept`,
      { quotationNumber, version },
      accessToken,
    );
  }
}

const sellAfter = admin('GET', '/v2/admin/orders/MB-ORD-ISO-SELL');
console.log(JSON.stringify({
  adminSignIn: sign.code,
  otpCode: otp.code,
  verifyCode: verified.code,
  buyStep: buy.json.workflow?.stepKey,
  sellStep: sell.json.workflow?.stepKey,
  acceptSell: { code: acceptSell.code, body: acceptSell.json },
  sellStepAfter: sellAfter.json.workflow?.stepKey,
}, null, 2));
