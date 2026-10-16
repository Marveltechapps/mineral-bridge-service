# Mineral Bridge Backend — Architecture

**Date:** 16 October 2026
**Status:** Proposed design for backend build (no backend code exists yet)
**Inputs:** the three client API contracts, summarised in [`endpoint-inventory.json`](endpoint-inventory.json). Unresolved decisions: [`API-OPEN-QUESTIONS.md`](API-OPEN-QUESTIONS.md).

---

## 1. Summary

One Node.js / Express application serves three clients over two mounts:

| Client | Mount | REST endpoints | Realtime | Principal | Auth |
|---|---|---:|---:|---|---|
| Mobile app | `/v1` | 106 | 3 WebSocket | Customer | Bearer + refresh token in body |
| Web app | `/v1` | 136 | 2 WebSocket + 1 SSE | Customer | Bearer + `mb_refresh` cookie |
| Admin console | `/admin/v1` | 139 | 1 SSE (already REST #60) | Staff | `mb_admin_session` cookie + CSRF |
| **Total rows** | | **381** | | | |

Mobile and web share **17 identical `METHOD + path` pairs** under `/v1` (plus one shared WebSocket URL, `/ws/auctions/{auctionId}`). They are the same route with different request and response contracts, so the app must disambiguate by client. Therefore the app mounts:

- **225 unique customer routes** (106 + 136 − 17), and
- **139 admin routes**,

= **364 mounted REST routes** serving the 381 inventory rows.

---

## 2. Single Express app

```
                          ┌───────────────────────── Express app ─────────────────────────┐
 Mobile  ── /v1/* ───────▶│  requestId → cors/helmet → detectClient → rateLimit            │
 Web     ── /v1/* ───────▶│     → customerAuth → kyc gate → idempotency → validate(client)  │──┐
                          │     → controller → service ──▶ domain object                     │  │
                          │     → serialize(client DTO mapper)                              │  │
 Admin   ── /admin/v1/* ─▶│  requestId → cors → cookieSession → csrf → requirePermission    │  │ shared
                          │     → idempotency/ETag → controller → service → admin DTO       │  │ services
                          └───────────────────────────────────────────────────────────────┘  │ + models
                                         HTTP server `upgrade` → /v1/ws/*   (WebSocket)      │
                                         SSE routes   → /events/*, /admin/v1/auctions/*/bids/stream
                                                                                              ▼
                                                                                        MongoDB (Mongoose)
```

Why one app, not three: the three contracts describe **one domain** (the same users, orders, auctions, KYC records and documents). Splitting into services now would duplicate models and make cross-client invariants (an admin pausing an auction, a mobile bid arriving) cross-process problems.

Rules that keep it from becoming a tangle:

1. **Services are client-agnostic.** They accept and return domain objects, never DTOs, and know nothing about `req.client`.
2. **Everything client-specific lives in `dto/`.** Validators (request) and mappers (response) are per client.
3. **Routing metadata is explicit.** Each route is registered with the clients that may call it (`clients: ['mobile']`, `['web']`, `['mobile','web']`). A call from a client not listed returns `404 route/not-available` rather than silently exposing an unreviewed surface.
4. **The inventory is the test oracle.** A contract test loads `endpoint-inventory.json` and fails if any `(method, fullPath)` row is not registered, or if a route exists that is not in the inventory.

### Suggested layout

```
src/
  app.ts                   # builds the Express app, mounts /v1 and /admin/v1
  server.ts                # http.Server, WebSocket upgrade handler
  config/
  common/
    middleware/            # requestId, detectClient, errors, idempotency, rateLimit, csrf
    money.ts  quantity.ts  # §6 — the only place minor⇄major conversion happens
    errors.ts              # per-client error-code registries
  models/                  # shared Mongoose schemas (§5)
  modules/<domain>/        # auth, kyc, catalog, orders, auctions, ...
    <domain>.service.ts
    customer.routes.ts     # mounted under /v1
    admin.routes.ts        # mounted under /admin/v1
    dto/{mobile,web,admin}.ts
  realtime/                # ws auction/sell/chat/negotiation channels, SSE
  routes/{v1.ts,admin.ts}
```

---

## 3. `/v1` — customer API (mobile + web)

### 3.1 Client detection

`detectClient` runs first on `/v1` and sets `req.client ∈ { 'mobile', 'web' }`:

| Order | Signal | Result |
|---|---|---|
| 1 | Verified access token with claim `cli` (authenticated routes) | authoritative; if the `X-Client` header disagrees → `403 auth/client-mismatch` |
| 2 | `X-Client: mineralbridge-mobile/<ver> (<build>)` | `mobile` |
| 3 | `X-Client: mineralbridge-web/<ver>` | `web` |
| 4 | `X-Platform: android \| ios` | `mobile` |
| 5 | none of the above | `web` **on shared routes only**, with a warning log |

Notes:

- The mobile contract mandates `X-Client` (plus `X-Platform`, `X-Device-Id`). The **web contract defines no `X-Client`**, so rule 5 is a stopgap until the web client sends one (open question **W-5**).
- Access tokens carry `cli` so a stolen mobile token cannot be replayed as web, and so refresh-token policy can differ by client (§4).
- Non-colliding routes do not need detection: `/learn/*`, `/catalog/*`, `/cart/*`, `/sell/*`, `/payouts/*`, `/me/*` imply mobile; `/lots`, `/academy/*`, `/negotiations/*`, `/lcs/*`, `/bank/*`, etc. imply web. Metadata (rule 3 above) enforces this.

### 3.2 Colliding routes

These 17 `METHOD + path` pairs exist in both contracts with **different** request and/or response shapes. One handler, two validators, two mappers. Full notes per route are in `sharedPathConflicts` in the JSON.

| # | Method + path | Mobile / Web refs | Severity | Main difference |
|--:|---|---|---|---|
| 1 | `POST /auth/otp/request` | #1 / #2 | high | `phone+intent` vs `method+identifier`; web adds email OTP |
| 2 | `POST /auth/otp/verify` | #2 / #3 | high | 6-digit, refresh token in body vs 4-digit, refresh cookie; different user payload |
| 3 | `POST /auth/otp/resend` | #3 / #4 | medium | web contract has no schema (W-7) |
| 4 | `DELETE /auth/account` | #7 / #11 | high | PIN header + `204` vs confirmation body + `202` scheduled |
| 5 | `GET /auth/sessions` | #8 / #9 | medium | `data[]`/`current` vs `items[]`/`isCurrent` |
| 6 | `DELETE /auth/sessions/{sessionId}` | #9 / #10 | low | same behaviour |
| 7 | `POST /orders` | #41 / #36 | high | product/cart requirement vs lot + paymentMethod |
| 8 | `GET /orders` | #42 / #37 | high | buy-only cursor vs buy+sell paged |
| 9 | `GET /orders/{orderId}` | #43 / #38 | high | flat order vs `{order, settlement, counterparty}` |
| 10 | `GET /orders/{orderId}/documents` | #45 / #41 | medium | inline `downloadUrl` vs `FileRef` + download call |
| 11 | `GET /auctions` | #62 / #51 | high | `status` vs `state`, different item schema |
| 12 | `GET /auctions/{auctionId}` | #63 / #52 | high | `bidding{}` + `version` vs `AuctionDetail` |
| 13 | `GET /auctions/{auctionId}/bids` | #64 / #53 | medium | `data` vs `items`; identity policy |
| 14 | `POST /auctions/{auctionId}/bids` | #65 / #54 | high | PIN + `version` + `acceptBinding` vs plain `{amount}` |
| 15 | `GET /notifications` | #86 / #124 | medium | different kinds, deep-link model, pagination |
| 16 | `POST /notifications/{notificationId}/read` | #88 / #125 | low | `200 {unreadCount}` vs `204` |
| 17 | `POST /support/tickets` | #94 / #129 | medium | topic/relatedTo vs subject/body |
| WS | `/ws/auctions/{auctionId}` | W1 / R1 | high | different handshake and event payloads |

Beyond exact collisions, **17 capabilities overlap under different paths** (e.g. `GET /me` vs `GET /auth/me`, `POST /auth/token/refresh` vs `POST /auth/refresh`, `/payouts/accounts` vs `/account/payout-methods`). Those are listed in `semanticOverlapsDifferentPaths`. They do not need dispatch — they are separate routes — but they must hit the **same service and model** so the data stays consistent.

### 3.3 Dispatch pattern

```ts
// common/byClient.ts
export const byClient =
  <T>(handlers: { mobile?: Handler; web?: Handler }): Handler =>
  (req, res, next) => (handlers[req.client] ?? notAvailable)(req, res, next);

// modules/auctions/customer.routes.ts
router.post(
  '/auctions/:auctionId/bids',
  requireAuth(), requireKyc(), idempotent(),
  byClient({
    mobile: [requirePin(), validate(mobileBidSchema), placeBid(toMobileBid)],
    web:    [validate(webBidSchema), placeBid(toWebBid)],
  }),
);

// placeBid is client-agnostic: it calls auctionService.placeBid(...) and serialises with the mapper it was given.
```

Error codes are part of the contract and differ (`kyc/not-verified` vs `kyc/not-approved`; `410 auction/closed` vs `409 auction/closed`). Services throw **domain errors** (`KycRequiredError`, `AuctionClosedError`); a per-client error registry turns them into the right status and code.

---

## 4. Authentication per client

| | **Mobile** (`/v1`) | **Web** (`/v1`) | **Admin** (`/admin/v1`) |
|---|---|---|---|
| Principal | `User` (customer) | `User` (customer) | `StaffUser` (separate collection) |
| Login | Phone + **6-digit** SMS/voice/WhatsApp OTP. No passwords | Mobile/email/WhatsApp OTP, **4-digit**. `POST /auth/password/change` exists (W-6) | Email + password (or SSO) → **6-digit** OTP challenge |
| Access credential | `Authorization: Bearer` JWT, 15 min | `Authorization: Bearer` JWT, 15 min (memory only) | **None** — opaque server session in `mb_admin_session` |
| Refresh | `refreshToken` in the **JSON body**; 60 days, rotating; replay → `401 auth/refresh-reused` and revoke the whole family | **`mb_refresh` cookie**: `HttpOnly; Secure; SameSite=Strict`, 30 days, rotating; old token tolerated for a **10 s grace window** | `POST /auth/refresh` rotates the session cookie, returns `X-CSRF-Token` |
| Refresh endpoint | `POST /auth/token/refresh` | `POST /auth/refresh` (the only `credentials: 'include'` call) | `POST /auth/refresh` |
| CSRF | N/A (no ambient credentials) | **Not specified** in the contract (W-2). Proposal: Origin allowlist + custom header on cookie-authenticated routes (`/auth/refresh`, `/auth/logout`) | `X-CSRF-Token` double-submit on every `POST/PUT/PATCH/DELETE`; missing/invalid → `403 auth/csrf` |
| Cookie scope | none | Contract says `Path=/auth`; the mounted route is `/v1/auth/*`, so it must be **`Path=/v1/auth`** or the browser will never send it (W-3) | `Path=/admin`, `SameSite=Strict` |
| Extra factors | `X-Transaction-Pin` on bids, withdrawals, account delete (5 failures → 30 min lock) | none | Four-eyes on money-moving actions; step-up OTP proposed (A-2); session lock/unlock; idle 30 min, absolute 12 h |
| Authorisation | KYC `verified` + account tier | KYC `verified`; role `bank_operator` for the 9 bank routes | RBAC matrix: module × `view`/`edit` (`Orders`, `Vault`, `Pricing`, `Auctions`, `Users`, `Compliance`, `Content`, `Financial`, `Settings`, `Support†`) |
| Realtime auth | `Sec-WebSocket-Protocol: mineralbridge.v1, bearer.<token>` (never in the query string) | `?token=<wsToken>` issued from `GET /auth/me`; contract is incomplete (W-1) | SSE with the session cookie |
| Gated-error | `403 kyc/not-verified {kycStatus}` | `403 kyc/not-approved` | `403 auth/forbidden`, `403 auth/four-eyes` |
| Rate limits | per-IP / per-number OTP limits | `POST /auth/otp/*` 3 / identifier / 15 min; bids 30/min | 600 req/min/session; auth 10 req/min/IP |

Implementation notes:

- **Two auth stacks, no shared session store key space.** `customerAuth` verifies JWTs and loads `User`; `adminAuth` loads an admin session and `StaffUser`. Never let a customer token authenticate on `/admin/v1` or the reverse; the admin mount does not run `customerAuth` at all.
- **Session family** (customer): one record per device login, with `client`, `refreshTokenHash`, `previousRefreshTokenHash`, `previousValidUntil`. Mobile policy = reuse revokes the family; web policy = previous hash valid for 10 s.
- **KYC gate** is server-enforced on every gated route (23 mobile, 17 web per the table; the web endpoint doc says 16 — W-8). `pending` is **not** sufficient.
- **OTP challenges** carry `client` and `codeLength`; challenges are never valid across clients.

---

## 5. Shared Mongoose models, client-specific DTOs

### 5.1 Principle

> **One persisted shape per concept; one serialiser per client.** Models use canonical enums and canonical units. Clients see their own vocabulary through mappers.

```
 Mongoose model  ──▶  service (domain object)  ──▶  dto/mobile.ts
 (canonical)                                    ├─▶  dto/web.ts
                                                └─▶  dto/admin.ts
```

Mappers are pure functions `(domain, ctx) => wire`. `ctx` carries `client`, locale (`Accept-Language`), viewer id (for `isYou`, `viewer{}`), and timezone. Presentation concerns stay in the mapper:

| Concern | Mobile | Web | Admin |
|---|---|---|---|
| IDs | prefixed (`ord_01H…`) + `reference` | opaque + `reference` | human-readable id is the id (`MB-SELL-41982`) |
| Pagination | cursor `{data, meta:{limit,nextCursor,counts}}` | `{items, page, perPage, total}` | `{data, meta:{page,pageSize,total,counts}}` |
| Display strings | server-sent `display`, `tone`, `statusLabel` | none (client formats) | none (tone derived client-side) |
| Quantity | `{value, unit g\|kg\|t, grams}` | `{value, unit g\|kg\|oz\|ct\|MT}` | `{value, unit kg\|t\|g\|oz}` |
| Timestamps | RFC 3339 UTC + `display` in WAT (UTC+1) | RFC 3339 UTC | ISO 8601 UTC, rendered EAT (UTC+3) |
| Optimistic concurrency | `version` in body | none | `expected…` fields, `If-Match`/ETag |

### 5.2 Aggregates (illustrative)

| Model | Used by | Canonical notes |
|---|---|---|
| `User` | mobile, web, admin (read/manage) | `tier` (1–3), `roles`, canonical `kycStatus`; web has no tier (W-11) |
| `StaffUser`, `Role`, `AdminSession` | admin only | separate principal |
| `OtpChallenge`, `SessionFamily`, `Device` | mobile, web | carries `client` |
| `KycSubmission`, `KycDocument` | all | canonical enum; per-client status mapper (W-4) |
| `Product`/`Lot`, `CatalogListing` | mobile (`product`), web (`lot`), admin (vault lot / listing) | one inventory collection |
| `Order` (+ `side`, 6 stages) | all | mobile = buy, web = buy+sell, admin = both (X-4) |
| `SellRequest`, `BulkQuote`, `Listing` (web sell) | mobile, web, admin intake | intake documents that spawn an `Order` |
| `Auction`, `Bid`, `AutoBid`, `Reminder` | all | one anti-sniping rule (+2 min in final 2 min) |
| `Document`, `FileObject` | all | one store; per-client file reference shape |
| `Notification`, `NotificationPref` | all | canonical kinds + per-client kind map |
| `PayoutAccount`/`PayoutMethod`, `Payout`, `Settlement` | mobile, web, admin | |
| `SupportTicket`, `ChatSession`, `CallbackRequest` | all | three status vocabularies (X-7) |
| `Negotiation`, `Contract`, `LetterOfCredit`, `Shipment`, `Passport` | web (customer), admin (oversight) | |
| `Course`, `Lesson`, `Progress`, `Certificate` | mobile (`learn`), web (`academy`), admin (CMS) | |
| `Banner`, `Partner`, `PlatformSettings`, `RateSnapshot`, `AuditLog` | admin write, others read | audit written by an admin-and-customer shared service |

Guidelines: store canonical enums (`unverified | pending | verified | rejected | resubmission_required`), store money as integer minor units (§6), store quantity in grams (`Decimal128`), keep the human `reference` as a separate unique field, never persist a presentation string.

### 5.3 Cross-cutting behaviour that must be shared

- **Idempotency:** `Idempotency-Key` accepted on money, bid, order, signature and ticket POSTs; replays within 24 h return the original response; key reuse with a different body → `409`. Lists differ by client (mobile 8 endpoints; web all money/trade POSTs; admin #32, #52, #72, #106 mandatory).
- **Audit:** every admin write, and every money/compliance customer action, produces an `AuditLog` row with actor, role, record, before/after.
- **Events:** domain events (`bid.placed`, `order.stage_changed`, `kyc.decided`…) are emitted once and fanned out to WebSocket, SSE, push (mobile) and notification rows.
- **Errors:** body `{ code, message, fields?, requestId }` is common to all three; the registry of codes is per client.

---

## 6. Money — customer APIs use minor units; admin uses major units

> ⚠️ **This is the single most dangerous inconsistency in the three contracts.** The same field name, `amount`, means *cents* on `/v1` and *dollars* on `/admin/v1`. A value that crosses the boundary unconverted is wrong by **100×** (or by 10⁸× for BTC).

### 6.1 Wire formats (from the contracts)

| | Mobile `/v1` | Web `/v1` | Admin `/admin/v1` |
|---|---|---|---|
| Shape | `{ amount, currency, scale }` (+ optional `display`) | `{ amount, currency }` | `{ amount, currency }` |
| Unit of `amount` | **Integer, minor units** | **Integer, minor units** | **Decimal number, major units** (≤ 2 decimals) |
| `scale` | explicit (`2`) | **absent** — exponent implied by ISO 4217 currency | absent |
| Currencies | USD (prefs also NGN, EUR, GBP) | ISO 4217 (also `paymentMethod: btc`) | `USD`, `KES`, `BTC` |
| Floats | forbidden | forbidden | decimals allowed by definition |
| Formatting | server may send `display` (`"$15.35M"`) | client formats | client formats |
| Unit price | `{ unitPrice: Money, per: "g" }` (minor per **gram**) | `Money` per quantity unit | `{ amount, currency, per: kg\|t\|g\|oz }` (major per unit) |

**Same amount in all three** — fifteen million three hundred fifty thousand US dollars:

| Client | Wire value |
|---|---|
| Mobile | `{ "amount": 1535000000, "currency": "USD", "scale": 2 }` |
| Web | `{ "amount": 1535000000, "currency": "USD" }` |
| Admin | `{ "amount": 15350000, "currency": "USD" }` |

Another: web `241000` = $2,410.00 and admin `5940000` = $5,940,000.00 — numbers that look comparable are not.

### 6.2 Internal representation

- **Persist integer minor units**, never major units, never floats: `{ amountMinor: Long (int64), currency: string }`. Name the field `amountMinor` in Mongoose schemas so a raw `amount` can never be mistaken for either wire format.
- **Currency exponent table** in one place (`common/money.ts`): `USD 2, KES 2, NGN 2, EUR 2, GBP 2, BTC 8`. The mobile `scale` must equal the table exponent — reject (`422`) or log if it does not.
- `BTC` minor unit = satoshi (10⁸). BTC is not ISO 4217; the web contract's "ISO 4217" statement does not cover it (W-14).
- Unit prices need more precision than whole minor units: mobile expresses price as integer minor per **gram** (e.g. `6140` = $61.40/g), admin as decimal major per **kg**. $63.805/g is not representable as an integer number of cents per gram. Store unit prices as `Decimal128` in major units per **gram**, convert per client, and round at the mapper with a documented rule. (Open: agree the precision.)

### 6.3 Conversion rules

```ts
// common/money.ts — the ONLY module allowed to convert
type MinorMoney = { amountMinor: bigint; currency: Currency };       // internal, branded
type MajorWire  = { amount: number; currency: Currency };            // admin wire
type MinorWire  = { amount: number; currency: Currency; scale?: number }; // mobile/web wire

toMobileWire(m)  -> { amount: Number(m.amountMinor), currency, scale: EXP[currency] }
toWebWire(m)     -> { amount: Number(m.amountMinor), currency }
toAdminWire(m)   -> { amount: minorToMajor(m), currency }            // decimal-string arithmetic, not float division

fromMobileWire(w) -> assert(w.scale === EXP[w.currency]); { amountMinor: BigInt(w.amount) }
fromWebWire(w)    -> { amountMinor: BigInt(w.amount) }               // reject non-integers
fromAdminWire(w)  -> { amountMinor: majorToMinor(w.amount, w.currency) }   // decimal parse, reject extra decimals
```

1. **Inbound admin:** parse `amount` from the JSON text as a decimal string (do not multiply a float by 100). More decimals than the currency exponent → `422 validation/failed` (do **not** silently round money). Non-finite or negative where not allowed → `422`.
2. **Outbound admin:** `minor / 10^exp` using decimal arithmetic and emit a JSON number with at most `exp` decimals.
3. **Inbound mobile/web:** `amount` must be a safe integer; fractional values → `422`.
4. **Computed values** (fees, totals, handling 1.8%, platform fee 1%/2%) are computed **once, in integer minor units, in the service**, with half-up rounding; mappers only convert units. Never recompute a total in a mapper.
5. **Cross-currency** (admin A-3: settlement carries the original amount and the USD equivalent) stores both as `MinorMoney` with the rate and timestamp used.
6. **`display`** (mobile only) is generated in the mobile mapper from the minor amount and locale; it is never parsed back.
7. **Limits:** int64 minor holds up to ~9.2×10¹⁸; JSON numbers are exact only to 2⁵³ ≈ 9.0×10¹⁵ minor (≈ $90 trillion for USD, ≈ 90 M BTC). Acceptable, but assert on output.

### 6.4 Safeguards

- Branded TypeScript types (`MinorMoney` vs `MajorWire`) so `amount` cannot be passed to the wrong function without a compile error.
- Lint rule / code-review rule: no `* 100`, `/ 100` or `Math.round(x * …)` outside `common/money.ts`.
- **Golden fixtures:** one domain record serialised for all three clients, asserting the 100× relationship (`admin.amount * 100 === web.amount`). Add one per money-bearing resource (orders, auctions/bids, listings, LC, settlements, payouts, rates).
- Contract tests per client that load the example payloads from the three contracts.
- Never log or hash `amount` without its wire context.

### 6.5 Quantity (related unit risk)

Store grams (`Decimal128`). Wire units differ: mobile `g|kg|t` (+`grams`), web `g|kg|oz|ct|MT`, admin `kg|t|g|oz`. `t` (mobile/admin) and `MT` (web) are both metric tonnes. `oz` must be defined as troy ounce (31.1034768 g) for precious metals — the contracts do not say; confirm.

---

## 7. `/admin/v1` — staff API

- Mounted under its own router with its own middleware stack (cookie session, CSRF, `requirePermission(module, 'view' | 'edit')`); **no customer middleware** is reachable from it.
- The first 12 endpoints (A: Auth & Session) cover sign-in, SSO, OTP, password reset, refresh, lock/unlock, sign-out and `/me`. Admin `GET /me` and `PATCH /me` are unrelated to the customer `/v1/me` despite the same path.
- All lists return `Page<T>` (`page`/`pageSize` ≤ 100, `sort`/`order`, `q`, per-endpoint filters), CSV exports return `text/csv`, and state transitions take `expected…` preconditions (`409 conflict/stale-state`) or `If-Match` (`412 conflict/etag-mismatch`).
- Money-moving actions (#32, #52, #72, #106) require `Idempotency-Key`, enforce four-eyes (`403 auth/four-eyes`), and are candidates for step-up OTP (A-2).
- The admin mutates the same Mongoose documents customers see (orders, auctions, KYC, listings). Admin actions go through the **same services** as customer actions so invariants (auction state machine, order stages, one open offer per negotiation) are enforced once.
- Realtime: SSE `GET /auctions/{id}/bids/stream` (heartbeat 15 s, `Last-Event-ID` replay for 10 min). Everything else is polled (chain events 15 s, counters/bell 60 s, rates 120 s).

---

## 8. Realtime

| Client | Channel | Transport | Auth |
|---|---|---|---|
| Mobile | `/v1/ws/auctions/{auctionId}` (W1) | WebSocket | subprotocol bearer |
| Mobile | `/v1/ws/sell-requests/{requestId}` (W2) | WebSocket | subprotocol bearer |
| Mobile | `/v1/ws/support/chat/{sessionId}` (W3) | WebSocket | subprotocol bearer |
| Web | `/v1/ws/auctions/{auctionId}` (R1) | WebSocket | `?token=<wsToken>` |
| Web | `/v1/ws/negotiations/{negotiationId}` (R2) | WebSocket | `?token=<wsToken>` |
| Web | `/v1/events/notifications` (R3) | SSE | unspecified (W-1) |
| Admin | `/admin/v1/auctions/{id}/bids/stream` (REST #60) | SSE | session cookie |

One `http.Server` `upgrade` handler routes by path; the handshake chooses the auth scheme and the connection's `client`, which selects the frame mapper. Web frames use `{ event, sequence, sentAt, data }` (gap ⇒ refetch); mobile frames use `{ event, at, data }`. Both must stay REST-recoverable (mobile fallbacks #64, #56, #100).

---

## 9. Known risks

| Risk | Where | Mitigation |
|---|---|---|
| 100× money error between `/v1` and `/admin/v1` | §6 | single conversion module, branded types, golden fixtures |
| Web request misclassified as mobile (or vice-versa) on a shared route | §3.1 | `cli` claim in JWT, require web `X-Client`, mismatch ⇒ `403` |
| Refresh cookie never sent (`Path=/auth` vs `/v1/auth`) | §4, W-3 | fix cookie path; integration test through the real mount |
| Cookie-authenticated mutations without CSRF defence on web | §4, W-2 | Origin allowlist + custom header |
| Realtime auth undefined for web | §8, W-1 | define `wsToken` before building R1–R3 |
| Three status vocabularies drift | §5, X-7 | canonical enums + mapping tables, tested |
| Inventory and implementation drift | §2 rule 4 | CI test against `endpoint-inventory.json` |
| Pending decisions block modules (tier changes, order model, pricing) | [`API-OPEN-QUESTIONS.md`](API-OPEN-QUESTIONS.md) §5 | resolve the "decide first" list before scaffolding shared infra |

---

## 10. Inventory facts used above

| | Mobile | Web | Admin |
|---|---:|---:|---:|
| REST endpoints (verified by parse) | 106 | 136 | 139 |
| `GET` / `POST` / `PUT` / `PATCH` / `DELETE` | 51 / 39 / 6 / 4 / 6 | 66 / 53 / 1 / 7 / 9 | 72 / 54 / 6 / 6 / 1 |
| Realtime | 3 WS | 2 WS + 1 SSE | 1 SSE (inside the 139) |
| Public (no credentials) | 24 | 34 (+1 cookie-only) | 7 incl. challenge/token |
| KYC-gated | 23 | 17 | — |
| Domains / modules | 14 | 20 | 23 |
