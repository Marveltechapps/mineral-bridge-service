# Frontend–Backend Integration and End-to-End Test Report

Date: 2026-11-19. Local working tree only. No commit was created. No production (Atlas) document was inserted, updated, or deleted for verification writes.

## Production-readiness assessment

**Not production-ready yet**, but the three product clients are now wired to the real `/v2` / `/v2/admin` APIs against a live database path (or isolated in-memory replicas for proof writes). Remaining gaps are incomplete screens on web (contact-change OTP, support inbox UI), some dashboard mutations that stay local when no admin write API exists, Next.js security upgrade pending, and no full browser Playwright suite across every UI control.

| Client | Live API | Demo / mock product data | Verdict |
|--------|----------|--------------------------|---------|
| **MB-Webapp** (customer web) | `/v2` with cookie refresh | Removed from live path; catalogue filled from API | Integrated; browser E2E of every screen not run |
| **MB-Frontend V1.2** (mobile) | `/v2` Bearer + refresh | Already integrated; DEV simulators gated | Integrated (pre-existing) |
| **MB-Dashboard** (admin) | `/v2/admin` cookie + CSRF | Seed only on manual reset when `!live` | Hybrid; core CRUD/auth live |

---

## 1. Frontend modules successfully integrated

### MB-Webapp (`MB-Webapp/`)

| Module | Integration |
|--------|-------------|
| Auth (OTP request / verify / register / refresh / logout) | `Remote` → `/v2/auth/*`; access token in memory; `mb_refresh` HttpOnly cookie |
| Session boot | Hydrate → `/v2/me` + catalogue / cart / orders / notifications |
| Profile / business type / prefs | `/v2/me`, `/v2/me/business-type`, `/v2/me/notification-preferences` |
| KYC submit + file uploads | `/v2/kyc`, `/v2/files` |
| Catalogue (categories, products, detail, documents) | `/v2/catalogue/*` into live `PRODUCTS`/`CATS` registries (start empty) |
| Cart | `/v2/cart` |
| Buy / sell orders + workflow actions | `/v2/orders/*` (quote, contract, pay, reports, receipt, cancel, chat, …) |
| Refunds | `/v2/refunds`, `/v2/orders/:ref/refunds` |
| Auctions + bids | `/v2/auctions/*` + WS |
| Notifications (list / read / SSE) | `/v2/notifications*` |
| Documents | `/v2/documents/:number` |
| Price variation screen | Added and wired |
| Env | `NEXT_PUBLIC_API_BASE_URL=http://localhost:5001/v2` |

Demo OTP, seeded users/orders/auctions, and localStorage persistence of business state were removed from the live path. Dev-only simulation UI requires `NEXT_PUBLIC_MB_DEV_TOOLS=1` in a non-production build.

**Still missing UI (API methods exist on `Remote`):** contact-change OTP screens; support inbox/thread screens; opening individual shipment transport documents.

### MB-Dashboard (`MB-Dashboard/`)

| Module | Integration |
|--------|-------------|
| Staff sign-in / OTP / sign-out | `/v2/admin/auth/*` |
| Console snapshot | `GET /v2/admin/me`, `GET /v2/admin/console` |
| Orders (step advance, reject, invoice) | Live when `db.live` |
| Customers (create, update, suspend, reinstate) | Live |
| Catalogue lots (create, patch, delete, hold) | Live |
| Auctions (create, delete) | Live |
| KYC decide, refunds transitions, payments reject | Live |
| Support reply/status/assign, notification retry | Live |
| Documents, partners patch, shipments, templates, invites, settings | Live |
| Env example | `VITE_API_URL=http://localhost:5001` (Vite proxies `/v2`) |

**Still local-only when live:** customer hard delete; manual KYC/refund/support/notification create-delete; partner delete; auction edit; lot reference price / min order fields; new buy/sell from console; template rename; lot media on create.

### MB-Frontend V1.2 (mobile)

Already connected via `context/remote.ts` and `src/services/*` to `/v2`. Typecheck passed in this run; no structural rewiring required.

---

## 2. Backend APIs connected

| Namespace | Client | Auth |
|-----------|--------|------|
| `/v2/auth`, `/v2/me`, `/v2/kyc`, `/v2/files`, `/v2/catalogue`, `/v2/cart`, `/v2/orders`, `/v2/auctions`, `/v2/refunds`, `/v2/documents`, `/v2/notifications`, `/v2/devices`, `/v2/support`, `/v2/reference` | Web + mobile (`X-Client: mineralbridge-web/*` or `mineralbridge-mobile/*`) | Bearer access; web refresh cookie on `/v2/auth` |
| `/v2/admin/*` | Dashboard (`X-Client: admin`, credentials include) | `mb_admin_session` + `X-CSRF-Token` on mutations |

Legacy `/v1` and `/admin/v1` remain mounted; new clients target `/v2` only. There is no `/api` product mount (starter sample pages may still expect legacy `/api/samples`).

---

## 3. Database integration verification

| Check | Result |
|-------|--------|
| Backend Vitest (mongodb-memory-server) | **374 passed** — CRUD, auth, CSRF, dashboard snapshot, buy/sell workflows, auctions, refunds, bridge |
| Web client HTTP smoke (memory DB :5022) | Auth, catalogue, cart, refresh, logout **PASS**; buy order **403** until KYC (expected) |
| Web buy E2E with KYC (memory DB :5023) | Register → KYC upload/submit → admin verify → cart → **POST /v2/orders 201** → admin quote → customer accept **PASS** (`scripts/iso-web-buy-order-e2e.ts`) |
| Dashboard integration test | Included in suite (3 tests) — console CRUD against memory replica |
| Atlas / configured `MONGODB_URI` | **Not written** for verification. Read-only Atlas ping was documented earlier in `Dashboard_Integration_Test_Report.md` |

Money remains minor units in MongoDB; console snapshot converts to major units for display.

---

## 4. Tests executed and actual results

| Suite / check | Command / method | Result |
|---------------|------------------|--------|
| Backend unit + integration | `npm test` in `mineralbridge-backend` | **374 passed / 0 failed** (43 files) |
| Backend v2 HTTP E2E | `npm run test:e2e` | **10 passed / 0 failed** |
| Backend lint | `npm run lint` | **PASS** (exit 0) |
| Backend `tsc` (build config) | `tsc -p tsconfig.build.json --noEmit` | **PASS** |
| Webapp typecheck | `npm run typecheck` in `MB-Webapp` | **PASS** |
| Webapp production build | `npm run build` (retry after Next security nudge) | **PASS** (exit 0) |
| Dashboard typecheck | `npm run typecheck` | **PASS** |
| Dashboard build | `npm run build` | **PASS** |
| Dashboard lint | `npm run lint` | **PASS** |
| Mobile typecheck | `npm run typecheck` in `MB-Frontend V1.2` | **PASS** |
| Web auth/CORS smoke (prior agent, :5021) | OTP → register → me/cart/orders → refresh/logout | **PASS** |
| Web client smoke (:5022) | 13 PASS, 1 FAIL (order without KYC), 1 SKIP | See §3 |
| Web KYC+buy E2E (:5023) | Full buy quotation accept | **PASS** |
| Full UI click-through of every button in browser | Not automated in this pass | **Not executed** |
| Mobile Jest / device E2E | Not re-run this pass | **Not executed** |

---

## 5. Issues identified and fixes implemented

1. **MB-Webapp was 100% localStorage demo** — Ported API client, services, mappers, and `Remote`; rewired `PlatformController` to call the backend; emptied catalogue registries; fixed `.env` to `http://localhost:5001/v2`.
2. **Wrong web API base** (`:3333/api`) — Corrected to `/v2` on port **5001**.
3. **Dashboard `.env.example` pointed at 3333** — Updated to **5001**.
4. **Dashboard live CRUD gaps** — Added persist helpers for customer create/update, lot create/delete, auction delete, partner create; login no longer fakes OTP; WhatsApp tab directs to email/password.
5. **Buy order without KYC returns 403** — Confirmed as intentional backend rule; full path works after KYC verify.
6. **Next.js security vulnerability nudge** — First builds aborted with `SecurityFatalError`; subsequent `next build` continued and succeeded. Upgrade still recommended (see below).

---

## 6. Remaining blockers

1. Web: no contact-change OTP or support-inbox screens (profile directs users to support for phone/email changes).
2. Dashboard: several console actions remain in-memory when no matching write API exists (see §1).
3. No automated Playwright/Cypress covering every web/dashboard control against a running stack.
4. Mobile release builds need production `API_BASE_URL` / `WS_BASE_URL` configured (`env.ts` prod URLs empty by design).
5. Backend `.env` may point at Atlas — use isolated scripts / memory servers for destructive tests; do not run write smokes against production.
6. Next.js security upgrade not applied yet.
7. Starter `/samples` pages still assume legacy `/api` which the current Express app does not mount as a product API.

---

## 7. Build status

| Package | typecheck | lint | build |
|---------|-----------|------|-------|
| `mineralbridge-backend` | PASS | PASS | (tsc build config PASS; full `npm run build` not separately timed beyond tsc) |
| `MB-Webapp` | PASS | (pre-existing a11y warnings only) | **PASS** after security nudge retry |
| `MB-Dashboard` | PASS | PASS | **PASS** |
| `MB-Frontend V1.2` | PASS | not re-run | N/A (RN) |

---

## 8. Final production-readiness assessment

The application is **integration-capable for staging**:

- Customer web and mobile speak the same `/v2` contract with real auth and database-backed catalogue/cart/orders.
- Admin dashboard loads and mutates core records through `/v2/admin` when signed in (`db.live`).
- Automated backend coverage is green (374 + 10 E2E). Isolated web buy path with KYC was proven end-to-end over HTTP.

It is **not** ready to declare production cutover until: Next.js is upgraded for the reported CVE; web missing screens are finished or explicitly deferred; remaining dashboard local-only actions are either wired or removed from live mode; production env/secrets/CORS/OTP providers pass `assertProductionConfig`; and a browser E2E pass is run against a non-production shared environment.

### Repeatable isolated scripts

```bash
cd mineralbridge-backend
npx tsx scripts/iso-web-buy-order-e2e.ts
# also: scripts/iso-customer-buy-sell-http.ts, scripts/iso-e2e-buy-sell-http.ts
# dashboard browser harness: scripts/isolated-admin-server.ts (port 5011)
```
