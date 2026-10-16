/**
 * Compares docs/endpoint-inventory.json with the routes the app really registers.
 *
 *   npm run coverage:endpoints                # admin must be 100 %; customer gaps are reported only
 *   npm run coverage:endpoints -- --strict    # customer (mobile + web) gaps also fail the run
 *   npm run coverage:endpoints -- --write     # also refresh docs/API-COVERAGE.generated.md
 *
 * Exit code 1 when any admin endpoint is missing/duplicated (or any customer one with --strict).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Route walking never touches the network or the DB; test-mode env defaults supply the secrets.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

type InventoryEndpoint = { n: number; method: string; path: string; auth: string; permission: string | null; purpose?: string };
type Inventory = { clients: Record<'mobile' | 'web' | 'admin', { basePrefix: string; endpoints: InventoryEndpoint[] }> };
type Found = { method: string; path: string; n?: number | null };

const args = new Set(process.argv.slice(2));
const strict = args.has('--strict');
const write = args.has('--write');

const norm = (p: string) => p.replace(/\{[^}]+\}|:[A-Za-z0-9_]+/g, '{}').replace(/\/+$/, '') || '/';
const key = (method: string, p: string) => `${method.toUpperCase()} ${norm(p)}`;

async function main(): Promise<void> {
  const inventory = JSON.parse(readFileSync(path.resolve('docs/endpoint-inventory.json'), 'utf8')) as Inventory;
  const { adminRouteRegistry } = await import('../src/app-clients/admin/routes.js');
  const { walkRoutes } = await import('../src/common/http/route-walk.js');
  const { buildV1Router } = await import('../src/routes/v1.js');

  const admin: Found[] = adminRouteRegistry();
  // yClient hides its routers inside closures, so walk the per-client auth/kyc routers explicitly.
  const [mobileAuth, webAuth, mobileKyc, webKyc] = await Promise.all([import('../src/modules/auth/mobile.auth.routes.js'), import('../src/modules/auth/web.auth.routes.js'), import('../src/modules/kyc/mobile.kyc.routes.js'), import('../src/modules/kyc/web.kyc.routes.js')]);
  const customer: Found[] = [...walkRoutes(buildV1Router()), ...walkRoutes(mobileAuth.createMobileAuthRouter()), ...walkRoutes(webAuth.createWebAuthRouter()), ...walkRoutes(mobileKyc.createMobileKycRouter()), ...walkRoutes(webKyc.createWebKycRouter())];

  const sections: string[] = [];
  let failed = false;
  const rows: string[] = [];

  for (const client of ['admin', 'mobile', 'web'] as const) {
    const expected = inventory.clients[client].endpoints;
    const found = client === 'admin' ? admin : customer;
    const foundKeys = new Map<string, Found[]>();
    for (const f of found) foundKeys.set(key(f.method, f.path), [...(foundKeys.get(key(f.method, f.path)) ?? []), f]);

    const missing = expected.filter((e) => !foundKeys.has(key(e.method, e.path)));
    const expectedKeys = new Set(expected.map((e) => key(e.method, e.path)));
    const extra = [...foundKeys.keys()].filter((k) => !expectedKeys.has(k));
    const duplicates = [...foundKeys.entries()].filter(([, v]) => v.length > 1).map(([k]) => k);
    const covered = expected.length - missing.length;

    console.log(`\n${client.toUpperCase()} — ${covered}/${expected.length} inventory endpoints registered (${((covered / expected.length) * 100).toFixed(1)} %)`);
    if (missing.length) {
      console.log(`  Missing (${missing.length}):`);
      for (const m of missing) console.log(`    #${m.n} ${m.method} ${inventory.clients[client].basePrefix}${m.path}`);
    }
    if (client === 'admin') {
      if (extra.length) console.log(`  Registered but not in the inventory (${extra.length}): ${extra.join(', ')}`);
      if (duplicates.length) console.log(`  Duplicate registrations: ${duplicates.join(', ')}`);
      if (missing.length || duplicates.length) failed = true;
    } else if (missing.length && strict) {
      failed = true;
    }

    sections.push(`### ${client} — ${covered}/${expected.length}`);
    for (const e of expected) {
      const ok = foundKeys.has(key(e.method, e.path));
      rows.push(`| ${client} | ${e.n} | ${e.method} | \`${inventory.clients[client].basePrefix}${e.path}\` | ${e.permission ?? e.auth} | ${ok ? '✅' : '❌'} |`);
    }
  }

  if (write) {
    const body = ['# API coverage (generated)', '', `Generated ${new Date().toISOString()} by \`npm run coverage:endpoints -- --write\`.`, '', '| Client | # | Method | Path | Auth / permission | Registered |', '|---|---|---|---|---|---|', ...rows, ''].join('\n');
    writeFileSync(path.resolve('docs/API-COVERAGE.generated.md'), body, 'utf8');
    console.log('\nWrote docs/API-COVERAGE.generated.md');
  }

  console.log(failed ? '\nCoverage check FAILED' : '\nCoverage check passed');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
