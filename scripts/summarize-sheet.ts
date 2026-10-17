import { readFileSync, writeFileSync } from 'node:fs';

const text = readFileSync('reports/catalog-sheet-snapshot.csv', 'utf8');
const rows: string[][] = [];
let row: string[] = [];
let cell = '';
let quoted = false;
for (let i = 0; i < text.length; i += 1) {
  const ch = text[i]!;
  if (quoted) {
    if (ch === '"' && text[i + 1] === '"') {
      cell += '"';
      i += 1;
    } else if (ch === '"') quoted = false;
    else cell += ch;
  } else if (ch === '"') quoted = true;
  else if (ch === ',') {
    row.push(cell);
    cell = '';
  } else if (ch === '\n') {
    row.push(cell);
    rows.push(row);
    row = [];
    cell = '';
  } else if (ch !== '\r') cell += ch;
}
if (cell.length || row.length) {
  row.push(cell);
  rows.push(row);
}
const data = rows.filter((r) => r.some((c) => c.trim()));
const headers = (data[0] ?? []).map((h) => h.trim());
const body = data.slice(1);
const cats = new Map<string, Map<string, string[]>>();
const gold: Array<Record<string, string>> = [];
const sectionHeaders: string[] = [];
for (const r of body) {
  const o = Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()]));
  if (!o['Mineral ID']) {
    sectionHeaders.push(o['Sub Category Name'] || o.Category || '(blank)');
    continue;
  }
  const c = o.Category || '(none)';
  const s = o['Sub Category Name'] || '(none)';
  if (!cats.has(c)) cats.set(c, new Map());
  const sm = cats.get(c)!;
  if (!sm.has(s)) sm.set(s, []);
  sm.get(s)!.push(`${o['Mineral ID']} ${o['Mineral Name']}`);
  if (/gold/i.test(`${c} ${s} ${o['Mineral Name']}`)) {
    gold.push({
      id: o['Mineral ID'] ?? '',
      cat: c,
      sub: s,
      name: o['Mineral Name'] ?? '',
      image: o['Primary Image'] ?? '',
    });
  }
}
const categories: Record<string, Record<string, string[]>> = {};
for (const [c, sm] of cats) {
  categories[c] = {};
  for (const [s, names] of sm) categories[c]![s] = names;
}
writeFileSync(
  'reports/catalog-hierarchy-summary.json',
  JSON.stringify({ headers, rowCount: body.length, sectionHeaders, gold, categories }, null, 2),
);
console.log(JSON.stringify({ rowCount: body.length, sectionHeaders, categoryNames: [...cats.keys()], goldCount: gold.length }));
