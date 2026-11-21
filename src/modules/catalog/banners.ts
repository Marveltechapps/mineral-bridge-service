import { loadEnv } from '../../config/env.js';
import { fetchCatalogCsv } from './sheet-sync.js';

/** Banner tab of the Mineral Bridge master sheet. The SKU tab is the catalog. */
export const BANNER_SHEET_GID = '1482026754';
const MASTER_SHEET_ID = '1ptk_PuNT5UTXP7L_0I5s-C3PY4Px_0_a';
const CACHE_MS = 5 * 60 * 1000;

export interface SheetBanner {
  name: string;
  url: string;
}

let cached: { at: number; items: SheetBanner[] } | null = null;

function parseCsv(text: string): string[][] {
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
  return rows;
}

/** Reads the Banner tab. The first rows are section labels, not the header. */
export function parseBannerCsv(csv: string): SheetBanner[] {
  const table = parseCsv(csv);
  const headerAt = table.findIndex((row) => {
    const labels = row.map((value) => value.trim().toLowerCase());
    return labels.includes('banner name') && labels.includes('banner url');
  });
  if (headerAt < 0) return [];
  const headers = table[headerAt]!.map((value) => value.trim().toLowerCase());
  const nameAt = headers.indexOf('banner name');
  const urlAt = headers.indexOf('banner url');
  const items: SheetBanner[] = [];
  for (const row of table.slice(headerAt + 1)) {
    const name = (row[nameAt] ?? '').trim();
    const url = (row[urlAt] ?? '').trim();
    if (!name || !/^https?:\/\//i.test(url)) continue;
    items.push({ name, url });
  }
  return items;
}

export function homePageBanners(items: SheetBanner[]): SheetBanner[] {
  return items.filter((item) => /^home page\b/i.test(item.name));
}

/** CloudFront's image function returns a 502 when a browser asks for AVIF. JPEG succeeds. */
export const BANNER_IMAGE_ACCEPT = 'image/jpeg,image/png;q=0.8';
const BANNER_IMAGE_HOST = 'd3spvxmx8kpy11.cloudfront.net';

export function homeBannerByName(items: SheetBanner[], name: string): SheetBanner | undefined {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return undefined;
  return homePageBanners(items).find((item) => item.name.toLowerCase() === wanted);
}

function allowedBannerUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === BANNER_IMAGE_HOST;
  } catch {
    return false;
  }
}

/** Bytes for one home-page banner. The sheet URL is fetched as JPEG so browsers can display it. */
export async function readHomeBannerImage(name: string): Promise<{ body: Buffer; contentType: string } | null> {
  const item = homeBannerByName(await listMasterBanners(), name);
  if (!item || !allowedBannerUrl(item.url)) return null;
  const response = await fetch(item.url, {
    headers: { Accept: BANNER_IMAGE_ACCEPT },
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  });
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!response.ok || !contentType.startsWith('image/')) return null;
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length < 32) return null;
  return { body, contentType };
}

export function clearBannerCache(): void {
  cached = null;
}

/** Live Banner tab. A recent successful read is reused for a few minutes. */
export async function listMasterBanners(): Promise<SheetBanner[]> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.items;
  const env = loadEnv();
  const { csv } = await fetchCatalogCsv({
    sheetId: env.CATALOG_SHEET_ID || MASTER_SHEET_ID,
    gid: BANNER_SHEET_GID,
  });
  const items = parseBannerCsv(csv);
  cached = { at: Date.now(), items };
  return items;
}
