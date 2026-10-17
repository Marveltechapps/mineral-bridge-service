import { readFileSync, writeFileSync } from 'node:fs';

const text = readFileSync('reports/catalog-sheet-snapshot.csv', 'utf8');
const rows: string[][] = [];
let row: string[] = [];
let cell = '';
let quoted = false;
for (let i = 0; i < text.length; i += 1) {
  const ch = text[i]!;
  if (quoted) {
    if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
    else if (ch === '"') quoted = false;
    else cell += ch;
  } else if (ch === '"') quoted = true;
  else if (ch === ',') { row.push(cell); cell = ''; }
  else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
  else if (ch !== '\r') cell += ch;
}
if (cell.length || row.length) { row.push(cell); rows.push(row); }
const data = rows.filter((r) => r.some((c) => c.trim()));
const headers = (data[0] ?? []).map((h) => h.trim());
const idx = (name: string) => headers.indexOf(name);
const results: Array<Record<string, string>> = [];
for (const raw of data.slice(1)) {
  const id = (raw[idx('Mineral ID')] ?? '').trim();
  const url = (raw[idx('Primary Image')] ?? '').trim();
  const name = (raw[idx('Mineral Name')] ?? '').trim();
  if (!id || !url) continue;
  let status = '0';
  let contentType = '';
  let detail = 'ok';
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(12000) });
    status = String(res.status);
    contentType = res.headers.get('content-type') ?? '';
    if (!res.ok) detail = `HTTP ${res.status}`;
    else if (contentType && !contentType.startsWith('image/') && !contentType.startsWith('application/octet-stream')) detail = contentType;
  } catch (err) {
    detail = err instanceof Error ? err.message : 'failed';
  }
  const matchesId = decodeURIComponent(url).toLowerCase().includes(id.toLowerCase());
  results.push({ id, name, status, contentType, matchesId: String(matchesId), detail, url });
}
const summary = {
  checked: results.length,
  imageOk: results.filter((r) => r.detail === 'ok').length,
  http403: results.filter((r) => r.status === '403').length,
  otherFailure: results.filter((r) => r.detail !== 'ok' && r.status !== '403').length,
  idMismatch: results.filter((r) => r.matchesId === 'false').map((r) => ({ id: r.id, name: r.name, url: r.url })),
};
writeFileSync('reports/catalog-image-check.json', JSON.stringify({ summary, results }, null, 2));
console.log(JSON.stringify(summary));
