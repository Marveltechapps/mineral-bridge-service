/**
 * Generates openapi/openapi.yaml (OpenAPI 3.0.3, high level) from docs/endpoint-inventory.json,
 * enriched with the real admin route table (idempotency / ETag-gated routes, SSE, four-eyes).
 *
 *   npm run openapi
 *
 * Request/response bodies are intentionally not modelled here; the authoritative field-level
 * contracts are mineralbridge-dashboard/docs/api/API-CONTRACT.md (admin) and the per-client
 * API-CONTRACT files. This document exists for tooling (Swagger UI at /docs, client generators, gateways).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

type Ep = { n: number; method: string; path: string; fullPath: string; auth: string; permission: string | null; domain?: string; purpose?: string; kyc?: boolean };
type Inventory = { clients: Record<'mobile' | 'web' | 'admin', { basePrefix: string; endpoints: Ep[] }> };

const FOUR_EYES = new Set([32, 52, 72, 106]);
/** Admin routes that call assertIfMatch (edit-gated resources): auction edit, listing edit, roles/platform/BTC settings. */
const ETAG_NUMBERS = new Set([42, 57, 130, 132, 134]);
const ETAG_GATED = new Set<string>();

const SECURITY: Record<string, Array<Record<string, string[]>>> = {
  public: [],
  bearer: [{ bearerAuth: [] }],
  'refresh-cookie': [{ webRefreshCookie: [] }],
  session: [{ adminSession: [], csrfToken: [] }],
  challenge: [],
  'reset-token': [],
  'locked-session': [{ adminSession: [] }],
};

function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : '')).replace(/^./, (c) => c.toLowerCase());
}

async function main(): Promise<void> {
  const inv = JSON.parse(readFileSync(path.resolve('docs/endpoint-inventory.json'), 'utf8')) as Inventory;
  const { adminRouteDefs } = await import('../src/app-clients/admin/routes.js');
  const idem = new Map<number, string>(adminRouteDefs.map((d) => [d.n, d.idempotency]));
  const sse = new Set(adminRouteDefs.filter((d) => d.sse).map((d) => d.n));

  const paths: Record<string, Record<string, any>> = {};
  const clientsSeen: Record<string, Set<string>> = {};

  for (const client of ['mobile', 'web', 'admin'] as const) {
    for (const e of inv.clients[client].endpoints) {
      const oaPath = e.fullPath;
      const method = e.method.toLowerCase();
      const key = `${method} ${oaPath}`;
      (clientsSeen[key] ??= new Set()).add(client);
      const existing = (paths[oaPath] ??= {})[method];
      if (existing) {
        // mobile + web share many /v1 paths: one operation, tagged with both clients.
        if (!existing.tags.includes(client)) existing.tags.push(client);
        existing['x-endpointNumbers'][client] = e.n;
        continue;
      }
      const params = [...oaPath.matchAll(/\{([^}]+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
      const op: Record<string, any> = {
        tags: [client, ...(e.domain ? [] : [])],
        operationId: `${client}_${method}_${slug(oaPath)}`,
        summary: e.purpose ?? `${e.method} ${e.path}`,
        description: e.domain ? `Domain: ${e.domain}` : undefined,
        parameters: params.length ? params : undefined,
        security: SECURITY[e.auth] ?? [{ bearerAuth: [] }],
        'x-endpointNumbers': { [client]: e.n },
        responses: {
          '200': { description: 'Success' },
          '400': { $ref: '#/components/responses/Error' },
          '401': { $ref: '#/components/responses/Error' },
          '403': { $ref: '#/components/responses/Error' },
          '422': { $ref: '#/components/responses/Error' },
        },
      };
      if (client === 'admin') {
        if (e.permission) op['x-permission'] = e.permission;
        const mode = idem.get(e.n);
        if (mode && mode !== 'off' && method === 'post') {
          op.parameters = [...(op.parameters ?? []), { $ref: '#/components/parameters/IdempotencyKey' }];
          if (mode === 'required') op['x-idempotency'] = 'required';
        }
        if (FOUR_EYES.has(e.n)) {
          op['x-fourEyes'] = true;
          op.responses['403'] = { description: 'Forbidden, including auth/four-eyes when the approver is the creator', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
        }
        if (sse.has(e.n)) {
          op.responses['200'] = { description: 'Server-Sent Events stream (events: bid, state, risk). Resume with Last-Event-ID.', content: { 'text/event-stream': { schema: { type: 'string' } } } };
        }
        if (ETAG_NUMBERS.has(e.n)) {
          op.parameters = [...(op.parameters ?? []), { $ref: '#/components/parameters/IfMatch' }];
          op.responses['412'] = { $ref: '#/components/responses/Error' };
          ETAG_GATED.add(key);
        }
        if (method === 'post' && (idem.get(e.n) ?? 'off') !== 'off') op.responses['409'] = { $ref: '#/components/responses/Error' };
      }
      (paths[oaPath][method] as unknown) = JSON.parse(JSON.stringify(op));
    }
  }

  const doc = {
    openapi: '3.0.3',
    info: {
      title: 'Mineral Bridge API',
      version: '1.0.0',
      description: [
        'High-level surface of the Mineral Bridge backend: 106 mobile + 136 web endpoints under `/v1`, 139 admin endpoints under `/admin/v1`.',
        '',
        'Generated by `npm run openapi` from `docs/endpoint-inventory.json` and the live admin route table.',
        'Field-level request/response shapes live in the API-CONTRACT.md documents of each client.',
        '',
        '**Admin conventions**: money is decimal major units; lists return `{data, meta:{page,pageSize,total,counts?}}`; mutations return `{data, message, auditId}`;',
        'errors are `{code, message, fields?, details?, requestId}`; edit-gated resources use `ETag` / `If-Match` (412 `conflict/etag-mismatch`);',
        'state-changing POSTs accept `Idempotency-Key` (required on #52, #72, #106; replays carry `Idempotent-Replay: true`);',
        'money-moving #32, #52, #72, #106 enforce four-eyes (403 `auth/four-eyes`).',
      ].join('\n'),
    },
    servers: [{ url: 'http://localhost:4000', description: 'Local development' }],
    tags: [
      { name: 'mobile', description: 'Native mobile app (bearer JWT)' },
      { name: 'web', description: 'Customer web app (bearer JWT + refresh cookie)' },
      { name: 'admin', description: 'Operations dashboard (httpOnly session cookie + CSRF double-submit; `x-permission` = module:view|edit)' },
    ],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Customer access token (15 min).' },
        webRefreshCookie: { type: 'apiKey', in: 'cookie', name: 'mb_refresh', description: 'httpOnly refresh cookie (web only).' },
        adminSession: { type: 'apiKey', in: 'cookie', name: 'mb_admin_session', description: 'Admin session cookie issued after password + OTP.' },
        csrfToken: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token', description: 'Required on every admin mutation; returned by OTP verify.' },
      },
      parameters: {
        IdempotencyKey: { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 128 }, description: 'Replays return the stored response. Same key + different body → 409 conflict/duplicate.' },
        IfMatch: { name: 'If-Match', in: 'header', required: false, schema: { type: 'string' }, description: 'ETag from the last GET; mismatch → 412 conflict/etag-mismatch.' },
      },
      responses: {
        Error: { description: 'Error envelope', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['code', 'message'],
          properties: {
            code: { type: 'string', example: 'validation/invalid' },
            message: { type: 'string' },
            fields: { type: 'object', additionalProperties: { type: 'string' } },
            details: { type: 'object', additionalProperties: true },
            requestId: { type: 'string' },
          },
        },
        AdminMoney: { type: 'object', required: ['amount', 'currency'], properties: { amount: { type: 'number', description: 'Decimal MAJOR units' }, currency: { type: 'string', example: 'USD' } } },
        AdminPageMeta: { type: 'object', properties: { page: { type: 'integer' }, pageSize: { type: 'integer' }, total: { type: 'integer' }, counts: { type: 'object', additionalProperties: { type: 'integer' } } } },
        ActionResult: { type: 'object', required: ['data', 'message', 'auditId'], properties: { data: { type: 'object', additionalProperties: true }, message: { type: 'string' }, auditId: { type: 'string' } } },
      },
    },
  };

  const clean = JSON.parse(JSON.stringify(doc)); // drops undefined keys
  mkdirSync(path.resolve('openapi'), { recursive: true });
  writeFileSync(path.resolve('openapi/openapi.yaml'), YAML.stringify(clean, { lineWidth: 0 }), 'utf8');
  const ops = Object.values(clean.paths as Record<string, Record<string, unknown>>).reduce((n, p) => n + Object.keys(p).length, 0);
  console.log(`Wrote openapi/openapi.yaml — ${Object.keys(clean.paths).length} paths, ${ops} operations (${ETAG_GATED.size} admin If-Match-capable)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
