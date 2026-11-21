# Mineral Bridge – backend

Express 4 + Mongoose 8 + zod, TypeScript (strict, ESM / NodeNext).
One service exposes three clients:

| Client | Base path | Auth |
|---|---|---|
| Mobile app | `/v1` | bearer JWT |
| Customer web | `/v1` | bearer JWT + httpOnly refresh cookie |
| Admin dashboard | `/admin/v1` | httpOnly session cookie + `X-CSRF-Token` (password → OTP, 2-step) |

Admin: 139 endpoints, full permission model, four-eyes on money movement, ETag/If-Match, idempotency,
append-only audit trail, SSE bid stream. See [docs/API-COVERAGE.md](docs/API-COVERAGE.md),
[docs/DATABASE.md](docs/DATABASE.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and `openapi/openapi.yaml` (Swagger UI at `/docs`).

## Prerequisites

* Node.js 20+ and npm
* Docker Desktop (for MongoDB). Transactions need a **replica set**; the compose file starts a single-node one.
  Tests do not need Docker – they use `mongodb-memory-server` (first run downloads a MongoDB binary).

## Setup – Windows PowerShell

```powershell
cd mineralbridge-backend

# 1. MongoDB replica set (waits until healthy)
docker compose up -d --wait mongo

# 2. Environment
Copy-Item .env.example .env       # then edit secrets; keep MONGODB_URI as in the example

# 3. Dependencies, seed data, dev server
npm install
npm run seed
npm run dev                        # http://127.0.0.1:5001  (health: /health, ready: /ready, docs: /docs)
```

`PORT` defaults to **5001** (see `.env.example`). The admin dashboard proxies to `API_BASE_URL`, which defaults to `http://127.0.0.1:5001`. Redis is optional: leave `REDIS_URL` unset for one API process. The process does not listen until MongoDB connects, so `/health` stays down until `docker compose up -d --wait mongo` has succeeded.

Seed with a custom admin password (applies for this PowerShell session only):

```powershell
$env:SEED_ADMIN_PASSWORD = "A-Long-Unique-Passphrase-1!"
npm run seed
```

## Setup – Windows CMD

```bat
cd mineralbridge-backend

rem 1. MongoDB replica set
docker compose up -d --wait mongo

rem 2. Environment
copy .env.example .env

rem 3. Dependencies, seed data, dev server
npm install
npm run seed
npm run dev
```

```bat
set SEED_ADMIN_PASSWORD=A-Long-Unique-Passphrase-1!
npm run seed
```

> **Variable name:** the app reads `MONGODB_URI` (not `MONGO_URI`). If your `.env` predates this repo, rename it.
> To use MongoDB Atlas instead of Docker, set `MONGODB_URI` to your `mongodb+srv://…` string. Never commit it.

> **Why `?directConnection=true`?** The replica-set member is advertised as `127.0.0.1:27017`, so a host-side Node
> process can connect without editing the Windows hosts file. Do not switch back to container host names
> (`mongo1:27017`) for host connections – the driver would fail to resolve them.

## Seeded data (`npm run seed`, idempotent)

* Reference data: categories, minerals, units, countries.
* Roles with permission matrices, platform settings, sample reference rates.
* One CEO admin: `SEED_ADMIN_EMAIL` (default `ceo@mineralbridge.co.ke`), password `SEED_ADMIN_PASSWORD`
  (default `ChangeMe!Admin1` – change it on first sign-in). Re-running the seed sets that password
  when the stored hash does not already match, and leaves every other staff row unchanged.

`POST /admin/v1/auth/sign-in` checks the email and password and returns the staff session cookie plus
`X-CSRF-Token`. Send that token on every mutation. `POST /admin/v1/auth/otp/verify` remains for a
challenge that was already issued.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | tsx watch server |
| `npm run build` / `npm start` | compile to `dist/` / run compiled server |
| `npm run typecheck` | `tsc --noEmit` (use `node --max-old-space-size=8192 node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` if it runs out of memory) |
| `npm test` | Vitest (in-memory MongoDB replica set, `NODE_ENV=test`) |
| `npm run coverage:endpoints` | compare `docs/endpoint-inventory.json` with the registered routes (`-- --strict`, `-- --write`) |
| `npm run openapi` | regenerate `openapi/openapi.yaml` |
| `npm run seed` | idempotent seed (see above) |

Run one test file: `npx vitest run tests/admin/admin-api.test.ts`.

## Configuration

Everything is in `.env.example`, with comments. Highlights:

| Variable | Purpose |
|---|---|
| `MONGODB_URI` | connection string (replica set required for transactions) |
| `JWT_*`, `ADMIN_SESSION_SECRET`, `WS_TOKEN_SECRET` | secrets – use long random values outside dev |
| `CORS_WEB_ORIGINS`, `CORS_ADMIN_ORIGINS`, `CORS_MOBILE_ORIGINS` | allow-lists (comma-separated) |
| `STAFF_EMAIL_DOMAINS` | domains allowed to sign in to the admin console |
| `SEED_ADMIN_*` | seeded CEO account |

### External providers (all optional)

Unset providers never fake success – the dependent endpoint answers with a clear error instead.

| Capability | Env | When unset |
|---|---|---|
| Admin SSO | `SSO_*` | 503 `auth/sso-unconfigured` |
| Blockchain anchoring | `BLOCKCHAIN_PROVIDER` | 503 `chain/provider-unconfigured` (anchors stay `queued`) |
| OTP SMS | `OTP_PROVIDER` (`fake`, `twilio`, …) | `fake` is refused in production; 503 `sms/provider-unconfigured` |
| Email | `EMAIL_PROVIDER` | 503 `email/provider-unconfigured` |
| Rate feed | `RATE_FEED_PROVIDER` | feed reports `unconfigured`; rates are entered manually |
| E-signature | `ESIGN_PROVIDER` | internal acknowledgement |

## Layout

```
src/app.ts                 middleware, /health, /ready, /docs, mounts /v1 and /admin/v1
src/server.ts              DB connect, HTTP + WebSocket upgrade, graceful shutdown
src/routes/v1.ts           customer router (mobile + web merged)
src/app-clients/admin/     admin router + route registry (used by the coverage script)
src/modules/admin/<domain> admin endpoints, one folder per API section
src/modules/audit          append-only audit log (before/after on every privileged write)
src/modules/reference      shared reference data
src/realtime               WebSocket and SSE hubs
scripts/                   seed, endpoint-coverage audit, OpenAPI generator, schema dump
tests/                     Vitest (tests/setup.ts provides mongodb-memory-server helpers)
```

## Testing notes

`tests/setup.ts` sets `NODE_ENV=test` and deterministic providers, and exports `startMemoryReplSet()` /
`useMemoryMongo()` for tests that need a real database (set `TEST_DB=memory` to start one for every file).
`tests/helpers/admin-harness.ts` builds the admin app against an in-memory replica set and signs staff in
through the real two-step flow.

## Troubleshooting

* **`MongoServerSelectionError` / transactions fail** – MongoDB is not a replica set. Use `docker compose up -d --wait mongo`
  and keep `directConnection=true` in the URI.
* **`Invalid environment configuration`** – a required variable is missing; copy `.env.example`.
* **Port 27017 in use** – stop a local `mongod` service, or change the published port in `docker-compose.yml` and the URI.
* **PowerShell blocks `npm.ps1`** – run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or use CMD.
