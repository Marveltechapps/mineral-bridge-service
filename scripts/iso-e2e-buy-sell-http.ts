/**
 * Walks buy and sell on the already-running isolated API (port 5011).
 * Uses real HTTP against the in-memory DB only — never Atlas.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = 'http://127.0.0.1:5011';
const jar = path.join(os.tmpdir(), 'mb-iso-e2e-cookies.txt');
const csrfFile = path.join(os.tmpdir(), 'mb-iso-e2e-csrf.txt');

async function raw(method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}) {
  const { spawnSync } = await import('node:child_process');
  const args = ['-sS', '-b', jar, '-c', jar, '-H', 'X-Client: admin', '-H', 'Accept: application/json', '-D', path.join(os.tmpdir(), 'mb-iso-e2e-headers.txt'), '-o', path.join(os.tmpdir(), 'mb-iso-e2e-body.json'), '-w', '%{http_code}'];
  if (method !== 'GET') {
    args.push('-X', method, '-H', 'Content-Type: application/json');
    const csrf = (await import('node:fs')).readFileSync(csrfFile, 'utf8').trim();
    if (csrf) args.push('-H', `X-CSRF-Token: ${csrf}`);
  }
  if (body !== undefined) {
    const f = path.join(os.tmpdir(), 'mb-iso-e2e-req.json');
    writeFileSync(f, JSON.stringify(body));
    args.push('--data-binary', `@${f}`);
  }
  args.push(`${BASE}${urlPath}`);
  const res = spawnSync('curl.exe', args, { encoding: 'utf8' });
  const status = Number(String(res.stdout || '').trim());
  const headerText = (await import('node:fs')).readFileSync(path.join(os.tmpdir(), 'mb-iso-e2e-headers.txt'), 'utf8');
  const m = /x-csrf-token:\s*(.+)/i.exec(headerText);
  if (m) writeFileSync(csrfFile, m[1].trim());
  const text = (await import('node:fs')).readFileSync(path.join(os.tmpdir(), 'mb-iso-e2e-body.json'), 'utf8');
  const json = text ? JSON.parse(text) : {};
  return { status, json };
}

writeFileSync(jar, '');
writeFileSync(csrfFile, '');
const sign = await raw('POST', '/v2/admin/auth/sign-in', { email: 'ceo@mineralbridge.test', password: 'Correct-Horse-9!Battery' });
if (sign.status !== 200) {
  console.error('sign-in failed', sign);
  process.exit(1);
}

const hold = await raw('POST', '/v2/admin/catalogue/lots/LOT-ISO-1/hold', { hold: true, reason: 'E2E hold check' });
const quote = await raw('POST', '/v2/admin/orders/MB-ORD-ISO-1/steps/quote', {
  lines: [{ productRef: 'LOT-ISO-1', amountMinor: 5000 }],
});
const consoleSnap = await raw('GET', '/v2/admin/console?page=1&pageSize=50');
const lot = (consoleSnap.json.lots || []).find((l: { id: string }) => l.id === 'LOT-ISO-1');
const order = (consoleSnap.json.orders || []).find((o: { id: string }) => o.id === 'MB-ORD-ISO-1');
const doc = (consoleSnap.json.docs || []).find((d: { no: string }) => d.no === 'CN-ISO-1');

console.log(JSON.stringify({
  signIn: sign.status,
  hold: hold.json,
  quoteStatus: quote.status,
  quoteBody: quote.json,
  lot,
  orderStep: order?.serverStep || order?.stage,
  orderStatus: order?.status,
  docFile: Boolean(doc?.fileId),
}, null, 2));
