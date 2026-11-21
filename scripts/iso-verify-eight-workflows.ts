/**
 * Drives the eight desk workflows + buy/sell quotation on isolated :5011 via HTTP.
 * Prints persistence evidence. No Atlas writes.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:5011';
const tmp = os.tmpdir();
const jar = path.join(tmp, 'mb-eight-jar.txt');
const csrfF = path.join(tmp, 'mb-eight-csrf.txt');
writeFileSync(jar, '');
writeFileSync(csrfF, '');

function curl(args: string[]) {
  const res = spawnSync('curl.exe', ['-sS', ...args], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(res.stderr || 'curl failed');
  return res.stdout || '';
}

function call(method: string, urlPath: string, body?: unknown) {
  const headersOut = path.join(tmp, 'mb-eight-h.txt');
  const bodyOut = path.join(tmp, 'mb-eight-b.json');
  const args = ['-b', jar, '-c', jar, '-H', 'X-Client: admin', '-H', 'Accept: application/json', '-D', headersOut, '-o', bodyOut, '-w', '%{http_code}'];
  if (method !== 'GET') {
    args.push('-X', method, '-H', 'Content-Type: application/json');
    const csrf = readFileSync(csrfF, 'utf8').trim();
    if (csrf) args.push('-H', `X-CSRF-Token: ${csrf}`);
  }
  if (body !== undefined) {
    const f = path.join(tmp, 'mb-eight-req.json');
    writeFileSync(f, JSON.stringify(body));
    args.push('--data-binary', `@${f}`);
  }
  args.push(`${BASE}${urlPath}`);
  const code = Number(curl(args).trim());
  const headers = readFileSync(headersOut, 'utf8');
  const m = /x-csrf-token:\s*(.+)/i.exec(headers);
  if (m) writeFileSync(csrfF, m[1]!.trim());
  const json = JSON.parse(readFileSync(bodyOut, 'utf8') || '{}');
  return { code, json };
}

const sign = call('POST', '/v2/admin/auth/sign-in', { email: 'ceo@mineralbridge.test', password: 'Correct-Horse-9!Battery' });
if (sign.code !== 200) throw new Error(`sign-in ${sign.code}`);

const evidence: Record<string, unknown> = { signIn: sign.code };

const hold = call('POST', '/v2/admin/catalogue/lots/LOT-ISO-1/hold', { hold: true, reason: 'Eight-workflow hold' });
evidence.hold = hold.json;

const buy = call('GET', '/v2/admin/orders/MB-ORD-ISO-1');
const buyQuote = call('POST', `/v2/admin/orders/MB-ORD-ISO-1/steps/quote`, {
  version: buy.json.version,
  data: { lines: [{ productRef: 'LOT-ISO-1', amountMinor: 5000 }] },
});
evidence.buyQuote = { code: buyQuote.code, step: buyQuote.json.workflow?.stepKey || buyQuote.json.code };

const payOrder = call('GET', '/v2/admin/orders/MB-ORD-ISO-PAY');
const pay = call('POST', `/v2/admin/payments/${encodeURIComponent(String(payOrder.json.reference || 'MB-ORD-ISO-PAY'))}/confirm`, {
  version: payOrder.json.version ?? 0,
  confirmedRef: 'TRX-EIGHT-1',
});
const console1 = call('GET', '/v2/admin/console?page=1&pageSize=50');
const payRow = (console1.json.orders || []).find((o: { id: string }) => o.id === 'MB-ORD-ISO-PAY');
evidence.paymentConfirmAttempt = { code: pay.code, body: pay.json, payOrderStep: payRow?.serverStep || payRow?.stage, payStatus: payRow?.pay?.status, payRef: payRow?.pay?.ref };

const refund = (console1.json.refunds || [])[0];
if (refund?.ref) {
  const r1 = call('POST', `/v2/admin/refunds/${encodeURIComponent(refund.ref)}/review`, {});
  const r2 = call('POST', `/v2/admin/refunds/${encodeURIComponent(refund.ref)}/approve`, {});
  evidence.refund = { review: r1.code, approve: r2.code, statuses: [r1.json.status, r2.json.status] };
}

const kyc = (console1.json.kyc || [])[0];
if (kyc?.ref || kyc?.id) {
  const id = kyc.id || kyc.ref;
  const k = call('POST', `/v2/admin/kyc/${encodeURIComponent(id)}/decide`, {
    decision: 'resubmission_required',
    reason: 'Address page unreadable',
  });
  evidence.kyc = { code: k.code, status: k.json.status || k.json };
}

const note = (console1.json.deliveries || []).find((d: { event?: string; status?: string }) => d.event === 'Payment update' || d.status === 'failed');
if (note?.id) {
  const n = call('POST', `/v2/admin/notifications/${encodeURIComponent(note.id)}/retry`, {});
  evidence.notification = { code: n.code, status: n.json.status };
}

const thread = (console1.json.threads || [])[0];
if (thread?.id) {
  const s = call('POST', `/v2/admin/support/${encodeURIComponent(thread.id)}/reply`, { body: 'Eight-workflow support reply.' });
  evidence.support = { code: s.code, msgs: s.json.messages?.length || s.json };
}

const pdf = Buffer.from('%PDF-1.4 eight-workflow').toString('base64');
const doc = call('POST', '/v2/admin/documents/upload', {
  number: 'CN-ISO-1',
  filename: 'eight.pdf',
  contentType: 'application/pdf',
  contentBase64: pdf,
});
const dl = call('GET', `/v2/admin/documents/CN-ISO-1/download`);
evidence.document = {
  upload: doc.code,
  fileId: doc.json.fileId,
  downloadPrefix: Buffer.from(dl.json.contentBase64 || '', 'base64').toString().slice(0, 8),
};

const ship = call('PATCH', '/v2/admin/shipments/MB-SH-ISO-1', { location: 'Eight Warehouse', status: 'in_transit', note: 'Eight-workflow move' });
evidence.shipment = { code: ship.code, location: ship.json.location, status: ship.json.status };

const sell = call('GET', '/v2/admin/orders/MB-ORD-ISO-SELL');
let sellStep = sell.json.workflow?.stepKey;
if (sellStep === 'reviewed') {
  const a = call('POST', `/v2/admin/orders/MB-ORD-ISO-SELL/steps/reviewed`, { version: sell.json.version });
  sellStep = a.json.workflow?.stepKey;
}
const sell2 = call('GET', '/v2/admin/orders/MB-ORD-ISO-SELL');
if (sell2.json.workflow?.stepKey === 'quote') {
  const q = call('POST', `/v2/admin/orders/MB-ORD-ISO-SELL/steps/quote`, {
    version: sell2.json.version,
    data: { offerMinor: 2500 },
  });
  evidence.sellQuote = { code: q.code, step: q.json.workflow?.stepKey };
}

const console2 = call('GET', '/v2/admin/console?page=1&pageSize=50');
const lot = (console2.json.lots || []).find((l: { id: string }) => l.id === 'LOT-ISO-1');
const buyO = (console2.json.orders || []).find((o: { id: string }) => o.id === 'MB-ORD-ISO-1');
const sellO = (console2.json.orders || []).find((o: { id: string }) => o.id === 'MB-ORD-ISO-SELL');
const payO = (console2.json.orders || []).find((o: { id: string }) => o.id === 'MB-ORD-ISO-PAY');
const rf = (console2.json.refunds || [])[0];
const ky = (console2.json.kyc || [])[0];
const th = (console2.json.threads || [])[0];
const dn = (console2.json.docs || []).find((d: { no: string }) => d.no === 'CN-ISO-1');
const del = (console2.json.deliveries || []).find((d: { event?: string }) => /Payment update/i.test(String(d.event || d.title || '')));

evidence.persisted = {
  lot: { onHold: lot?.onHold, reason: lot?.holdReason },
  buy: { step: buyO?.serverStep || buyO?.stage },
  sell: { step: sellO?.serverStep || sellO?.stage },
  pay: { step: payO?.serverStep || payO?.stage, status: payO?.pay?.status, ref: payO?.pay?.ref },
  refund: rf?.status,
  kyc: ky?.status,
  supportMsgs: th?.msgs?.length,
  docFile: Boolean(dn?.fileId),
  notification: del?.status,
};

console.log(JSON.stringify(evidence, null, 2));
