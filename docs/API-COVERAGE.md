# API coverage

Single source of truth for *what must exist*: [`docs/endpoint-inventory.json`](./endpoint-inventory.json)
(381 REST endpoints: mobile 106, web 136, admin 139; parsed from the three `API-ENDPOINTS.md` files).

Single source of truth for *what does exist*: the Express routers themselves. The audit script walks
them (`adminRouteRegistry()` for admin, the `/v1` router + per-client auth/KYC routers for customers) and
compares method + path with the inventory.

```powershell
npm run coverage:endpoints                 # admin must be 100 %; customer gaps are listed but do not fail
npm run coverage:endpoints -- --strict     # customer gaps fail the run too (use in CI once all agents are done)
npm run coverage:endpoints -- --write      # also writes docs/API-COVERAGE.generated.md (full per-endpoint matrix)
```

Exit codes: `0` ok, `1` coverage failure (missing/duplicate admin route, or any gap with `--strict`), `2` script error.
Path parameters are normalised (`:id` and `{id}` both become `{}`), so naming differences never count as gaps.

## Admin API (`/admin/v1`) – 139 / 139

Endpoint numbers are those of `API-ENDPOINTS.md`. Auth (#1–12) is served by `modules/auth/admin.auth.routes.ts`;
#13–139 are declared with `route()` in `src/modules/admin/**` and aggregated in `src/app-clients/admin/routes.ts`.

| Section | Domain | # | Module (`src/modules/admin/…`) | Notes |
|---|---|---|---|---|
| A | Auth & session | 1–12 | `../auth/admin.auth.routes.ts` | Other agent; SSO → 503 `auth/sso-unconfigured` when unset |
| B | Shell, search, notifications, lookups | 13–19 | `shell/` | |
| C | Overview | 20–22 | `overview/` | KPIs computed from live collections |
| D | Orders | 23–33 | `orders/` | #32 four-eyes (money moving); ETag on detail |
| E | Vault & inventory | 34–37 | `vault/` | |
| F | Catalog listings | 38–45 | `listings/` | #42 If-Match |
| G | Pricing & rates | 46–52 | `pricing/` | #52 four-eyes + required `Idempotency-Key`; rates are entered manually; feed status reports `unconfigured` when `RATE_FEED_PROVIDER` is unset |
| H | Auctions | 53–66 | `auctions/` | #57 If-Match; #60 SSE `bids/stream` |
| I | LC & payments | 67–73 | `lc/` | #72 four-eyes + required `Idempotency-Key` |
| J | Collaboration | 74–81 | `collab/` | |
| K | Blockchain monitor | 82–87 | `chain/` | Anchoring → 503 `chain/provider-unconfigured` when unset |
| L | Users & accounts | 88–97 | `people/users.routes.ts` | PII masked for view-only roles |
| M | Verification & compliance | 98–101 | `people/compliance.routes.ts` | |
| N | Disputes & resolution | 102–107 | `people/disputes.routes.ts` | #106 four-eyes + required `Idempotency-Key` |
| O | Academy | 108–112 | `content/academy.routes.ts` | |
| P | Marketing | 113–115 | `content/marketing.routes.ts` | |
| Q | Partners & logistics | 116–118 | `partners/` | |
| R | Enquiries & support | 119–122 | `support/` | |
| S | Audit log | 123–124 | `audit/` | Reads `AuditLog` (append-only) |
| T | Financial & reporting | 125–127 | `settlements/` | PDF statement → 501 `export/format-unsupported` |
| U | Analytics | 128 | `analytics/` | |
| V | Settings | 129–134 | `settings/` | #130, #132, #134 If-Match |
| W | Profile | 135–139 | `profile/` | |

### Cross-cutting behaviour (applies to every admin route)

| Concern | Where | Behaviour |
|---|---|---|
| Authentication | `adminSession` (other agent) | cookie `mb_admin_session`; 401 `auth/unauthenticated` |
| CSRF | `csrfProtect` | `X-CSRF-Token` on every non-GET; 403 `auth/csrf` |
| Permission | `requireStaffPermission(module, level)` | 403 `auth/forbidden`; `edit` implies `view` |
| Validation | zod on `body`/`query`/`params` | 422 `validation/invalid` with `fields` |
| Idempotency | `Idempotency-Key` | optional on state-changing POSTs, required on #52/#72/#106; replay header `Idempotent-Replay: true`; same key + other body → 409 `conflict/duplicate` |
| Optimistic concurrency | `ETag` / `If-Match` | 412 `conflict/etag-mismatch` |
| Four-eyes | `assertFourEyes` | 403 `auth/four-eyes` when approver = creator |
| Audit | `recordAudit` | every privileged write stores before/after, actor, reason, request id |

## Customer APIs (`/v1`) – mobile 106 / 106 · web 136 / 136

Owned by the customer-app modules (not `modules/admin`). Both client inventories are fully registered
(`npm run coverage:endpoints` → 100 %). A `✅/❌` row per endpoint is in
`docs/API-COVERAGE.generated.md` after `--write`.

## Realtime

| Channel | Where | Notes |
|---|---|---|
| Admin SSE `GET /admin/v1/auctions/:auctionId/bids/stream` (#60) | `modules/admin/auctions` | persisted `AuctionEvent` (TTL) → resume with `Last-Event-ID`; events `bid`, `state`, `risk` |
| Customer WebSocket `/v1/ws/auctions/:id` | `src/realtime/ws-server.ts` | bearer token or `?token=`; `?since=` replay; heartbeat |

## Keeping this file honest

* Add new endpoints to the inventory first, then implement, then re-run `npm run coverage:endpoints`.
* Regenerate `openapi/openapi.yaml` with `npm run openapi` after the inventory or admin route table changes.
* Tests: `tests/admin/admin-api.test.ts` asserts the registry matches the inventory (139) and
  `tests/admin/smoke.test.ts` hits every parameter-less admin GET and every `:id` GET (404, never 500).
