# Mineral Bridge Backend — Consolidated Open Questions

**Date:** 16 October 2026
**Scope:** every unresolved decision across the three API contracts, plus cross-contract conflicts found while building [`endpoint-inventory.json`](endpoint-inventory.json).
**Companion:** [`ARCHITECTURE.md`](ARCHITECTURE.md)

| Source | Document | Questions | Origin |
|---|---|---:|---|
| Mobile (`/v1`) | `mineralbridge-mobile-app/docs/API-CONTRACT.md` §15 | 20 (M-1 … M-20) | Stated by the contract |
| Admin (`/admin/v1`) | `mineralbridge-dashboard/docs/api/API-CONTRACT.md` §9 | 7 (A-1 … A-7) | Stated by the contract |
| Web (`/v1`) | `Mineral_Bridge_Web_Final/docs/API-CONTRACT.md` | 14 (W-1 … W-14) | **Inferred** — the web contract has no open-questions section; these are gaps found by reading it against the other two |
| Cross-contract | all three | 12 (X-1 … X-12) | **Inferred** — conflicts only visible when contracts are compared |
| | | **53** | |

How to read the "Proposed default" column: for M- and A- items it is the contract's own assumption where one is given; otherwise (and always for W- and X- items) it is a **proposal by the backend team** to unblock implementation, not a decision. Anything marked **BLOCKER** stops a route from being implemented at all.

---

## 1. Mobile — contract §15 (20)

| ID | Topic | Question | Blocks | Proposed default |
|---|---|---|---|---|
| M-1 | Pricing authority | The app computes estimate band, offer, cart handling fee (1.8%) and indicative totals locally. The contract moves all of it server-side. Can the pricing service answer within the 20 s budget, and who owns the refining-deduction parameter? | #39, #40, #49, #58 | Server-side pricing; deduction lives in admin Pricing settings (`Pricing:edit`). See X-6 |
| M-2 | Reference-rate freshness | `sEstimate` promises "Rate updated 4 minutes ago". What is the real refresh interval, and should an estimate be refused when the rate is stale beyond a threshold? | #49, #106 | Refuse estimates when feed older than a configurable limit (admin feed-status #46 already tracks health) |
| M-3 | Estimate validity | §9.7 proposes `expiresAt` on an estimate. Does one exist commercially, and can a booking be made against an expired estimate? | #49, #51 | Estimate carries `expiresAt`; booking against an expired estimate is re-priced, not rejected |
| M-4 | Offer expiry under review | #61 pauses the 48-hour clock while a review is open. Intended, or hard 48 h from issue? | #58, #61 | Pause while review is open (contract's reading). Admin firm offers are "valid 48 h" (admin #32) — must match |
| M-5 | Partial order fulfilment | Can a buy requirement be partially filled from the vault with the balance sourced within 14 days — one order or two? | #41 | One order, partial allocation recorded as lines |
| M-6 | Cart ↔ order | Does checking out a multi-line cart create one order or one per line? `bDone` shows a single reference. | #35–#41 | One order per checkout |
| M-7 | Guest cart | Anonymous cart merged on sign-in, or #35–#39 authenticated-only? | #35–#39 | Authenticated-only (as specified) |
| M-8 | Auction anti-sniping | Does close time extend on a late bid? Contract assumes +2 min within the last 2 min. | #63, #65, W1 | **Largely answered by the web contract** (+2 min when bid lands in final 2 min). Confirm and share one constant. Event reason string differs: `anti_sniping` (mobile) vs `anti_snipe` (web) |
| M-9 | Bidder identity | May a trading name be shown ("Aurora Refining") or must all bidders be pseudonymous ("Bidder #4417")? | #64 | **Conflicts with the web contract**, which says always pseudonymous. See X-8 |
| M-10 | Bid deposits | Are bids backed by a deposit/hold? Bids are "binding" but nothing collects one. | #65 | No deposit in v1; keep KYC + PIN as the control; revisit with finance |
| M-11 | Payout account creation | #76 is specified but the app has no form. Mobile flow, support-desk action, or web-only? | #76 | Keep the endpoint; ship UI later |
| M-12 | PIN enrolment | Where is the transaction PIN first set? `settings` offers "Change PIN" but signup never creates one. | #10, #65, #79, #7 | Prompt to set PIN before first bid/withdrawal; `PUT /auth/pin` without `currentPin` |
| M-13 | Multi-currency | Currency preference offers USD, NGN, EUR, GBP. Display-only conversion, or are orders/payouts denominated in it? | Money everywhere | Display-only in v1; settle in USD. See X-5 for the currency set |
| M-14 | Localisation scope | Five languages (en, ha, yo, ig, fr). Does it cover desk-authored timeline copy and document names, or static UI only? Determines whether `display` fields are localised. | All `display` fields | Static UI + `display` strings from `Accept-Language`; desk-authored copy English-only |
| M-15 | Document expiry enforcement | Does an expired export permit block a Tier 3 bulk submission or only warn? `docs` warns at 21 days; `iStep2` is silent. | #52, #83 | Block on expired, warn at 21 days. See X-9 |
| M-16 | Evaluator contact | Does "Call Emeka Balogun" place a real masked call, or raise a callback? #103 assumes callback; the toast says "Calling…". | #103 | Callback (as #103); change the toast copy |
| M-17 | Chat outside desk hours | #99 returns `503` when closed. Queue an offline message instead? | #99 | Queue an offline message and create a ticket |
| M-18 | KYC re-submission | After rejection, is a fresh submission allowed immediately, and how many attempts before manual review? | #25 | Immediate resubmission; manual review after 3 attempts. See X-9 |
| M-19 | Tier downgrade | May an account move Tier 3 → Tier 1, and what happens to in-flight bulk consignments? | #16 | Block downgrade while bulk quotes are open. **Also see X-1** (admin requires a compliance-reviewed tier request) |
| M-20 | Data retention on deletion | `DELETE /auth/account` promises permanent removal; reconcile with KYC/AML retention. Copy may need changing, not just the endpoint. | #7 | Soft-delete + anonymise PII; retain KYC/transaction records for the statutory period; change the sheet copy. See X-10 |

---

## 2. Admin — contract §9 (7)

| ID | Topic | Question | Blocks | Contract's assumed default |
|---|---|---|---|---|
| A-1 | Role matrix coverage | The role matrix has 9 modules but the console has 21 screens. Support, Partners, Audit, Analytics, LC, Collab and Chain have no column. | Authorisation on #19, #74–#87, #116–#124, #128 | Added a `support` module. Partners → Orders, LC/Chain/Analytics → Financial, Collab → Orders, Audit → Settings:view. **Product to confirm.** (Flagged as `permissionModuleUnconfirmed` in the inventory: 10 endpoints) |
| A-2 | Step-up for money release | Should LC payment release (#72) and dispute settlement adjustments (#106) require OTP step-up? | #72, #106 | Recommended: `X-Step-Up-Token` from a fresh challenge for amounts > $250k |
| A-3 | Currencies | Demo is all USD. Seller payouts in KES (M-Pesa)? | `Money.currency` | `USD`, `KES`, `BTC`; settlements carry original amount and USD equivalent. See X-5 |
| A-4 | Draft ownership | Are drafts per-user or shared with the desk? | All create endpoints with `draft:true` | Shared within the module, visible with `status=draft` |
| A-5 | Auction duration | Create form shows a fixed "5 days"; configurable? | #55 | `endsAt` required, 1 h – 14 days |
| A-6 | Catalog purchase → order | Does a buyer purchase from a catalog listing create the Buy order automatically, and where does it enter the pipeline? | #23, #40 | Yes, at Verification (same as an auction win) |
| A-7 | Bitcoin rails | Lightning vs on-chain: is the provider integration in this API? | #133, #134 | Out of scope; API only toggles per-country availability |

---

## 3. Web — inferred gaps (14)

The web contract (`API-CONTRACT.md`, 26 sections) lists no open questions. These are places where it is silent, internally inconsistent, or incompatible with the infrastructure the other clients need.

| ID | Topic | Gap | Blocks | Proposed default |
|---|---|---|---|---|
| W-1 | **`wsToken`** | §24 says to issue "a dedicated `wsToken` from `GET /auth/me`", but the `/auth/me` response schema has no `wsToken` field, and nothing defines its lifetime, single-use rule, scope (per channel?), or how it is renewed on reconnect (re-call `/auth/me`? a new endpoint?). Mobile's contract forbids tokens in the query string, yet both clients use the *same* URL `/v1/ws/auctions/{auctionId}`. R3 (`GET /events/notifications`, SSE) is `S`-authenticated but browser `EventSource` cannot send `Authorization`, and no `wsToken` use is specified for it. | R1, R2, R3, `GET /auth/me` | **BLOCKER for realtime.** Add `wsToken: { value, expiresAt }` to `/auth/me`, 60 s single-use, bound to user + channel prefix; add `POST /auth/ws-token` for reconnects; accept `?token=` for SSE. Mobile keeps `Sec-WebSocket-Protocol` bearer. Needs an endpoint-count decision (this would be #137) |
| W-2 | **CSRF** | The refresh token is a `SameSite=Strict` cookie, and `POST /auth/refresh` and `POST /auth/logout` are cookie-authenticated mutations. No CSRF token, Origin/Referer check or custom-header requirement is specified. (Admin uses `X-CSRF-Token` double-submit; web has nothing equivalent.) The contract also demands `Access-Control-Allow-Credentials: true` with an origin allowlist but names no origins. | #5 `/auth/refresh`, #6 `/auth/logout` | Require `Origin` ∈ allowlist and a custom header (e.g. `X-Requested-With: mb-web`) on cookie-authenticated routes; document the allowlist per environment |
| W-3 | **Refresh cookie `Path`** | Contract sets `mb_refresh; Path=/auth`, but under the single-Express design the route is `/v1/auth/refresh`. A browser will not send a `Path=/auth` cookie to `/v1/auth/refresh`, so refresh would silently fail. | #3 verify, #5 refresh, #6 logout | Set `Path=/v1/auth`, and keep cookie name `mb_refresh`. Needs web team sign-off |
| W-4 | **KYC status enum** | Web: `unverified \| pending \| verified` on `/auth/me` and `/auth/otp/verify`, plus `rejected` only on `GET /kyc`. Mobile: `none \| pending \| verified \| rejected`. Admin: `in_review \| expiring_docs \| verified \| awaiting_resubmission \| rejected`. Gate error code also differs: `kyc/not-approved` (web) vs `kyc/not-verified` (mobile). | All 17 web / 23 mobile KYC-gated endpoints | One internal enum (`unverified, pending, verified, rejected, resubmission_required`); per-client mapper (`unverified`⇄`none`). Send the client-specific error code. Web should also expose `rejected` on `/auth/me` |
| W-5 | **Client detection** | The mobile contract mandates `X-Client: mineralbridge-mobile/<ver> (<build>)`. The web contract defines **no** `X-Client`, so the backend cannot positively identify web on the 17 colliding routes. | The 17 shared REST routes + R1 | Require `X-Client: mineralbridge-web/<ver>` from web; until shipped, treat "no `X-Client`, no `X-Platform`" as web on collision routes only, and log it |
| W-6 | **Password vs OTP-only accounts** | `POST /auth/register` collects no password and sign-in is OTP-only, yet `POST /auth/password/change` requires `currentPassword` and a 10-char policy. Mobile has no passwords at all. How does an OTP-only account set its first password? | #8 `/auth/password/change` | Treat as "set/change"; omit `currentPassword` when none exists. Confirm that web accounts may have passwords at all |
| W-7 | **OTP resend contract missing** | `POST /auth/otp/resend` (#4) appears in the endpoint list and error registry but has **no schema section** in the contract. | #4 | Mirror mobile: `{ challengeId }` → same body as `/auth/otp/request` |
| W-8 | **KYC-gated count** | Endpoint list §23 says 16 KYC-gated endpoints but the table (and contract) mark 17: `POST /lcs/{lcId}/amendments` is omitted from §23. | #110 | Treat as KYC-gated (17); fix the web doc |
| W-9 | **OTP length** | Web OTP is 4 digits (`codeLength: 4`, "changing it is a breaking change"); mobile is 6 digits; admin is 6. Challenges therefore cannot be shared. | `/auth/otp/*` | Challenge records carry `client` and `codeLength`; never share a challenge across clients |
| W-10 | **Refresh reuse policy** | Web must tolerate the old refresh token once more within a **10 s grace window**; mobile treats any reuse as theft (`auth/refresh-reused`, revoke the whole family). | #5 | Per-client policy flag on the session family |
| W-11 | **Tier model** | Web has no account tiers (roles: buyer/seller/both/bank_operator/admin). Mobile tiers (1/2/3) route the sell flow; admin manages tiers and tier requests. What tier does a web-only user have, and does web sell routing depend on it? | #45 `POST /listings`, user model | Single `tier` on the user; web ignores it for routing; new web users default to Tier 1. Confirm with product |
| W-12 | **Order id / reference** | Web `Order.id` example is `"MB-ORDER-33056"`, contradicting its own rule that ids are opaque and references are separate fields. Mobile uses `ord_01H…` + `MB-2026-04871`; admin uses `MB-BUY-38217`/`MB-SELL-41982` as the id. | All order routes | Opaque ObjectId-backed `id`; one canonical `reference`; per-client format via mapper. See X-3 |
| W-13 | **Bank-operator identity** | Nine bank-portal endpoints need role `bank_operator`, but admin has no UI/endpoint to create or manage bank operators, and customers cannot self-select the role. | #111–#119 | Provision via an admin endpoint (not in the 139) or seed manually; confirm owner |
| W-14 | **`BTC` and non-ISO currencies** | Web `Money.currency` is "ISO 4217" yet `paymentMethod` includes `btc`; BTC is not ISO 4217 and the contract defines no `scale`. | `POST /orders`, `/orders/quote` | See X-5 |

---

## 4. Cross-contract conflicts (12)

| ID | Topic | Conflict | Affects | Proposed default |
|---|---|---|---|---|
| X-1 | **Tier changes** | Mobile `PUT /me/tier` (#16) lets the user change tier directly. Admin makes tier changes a compliance-reviewed request (`POST /tier-requests` → `…/decision`, `Compliance:edit`). | #16, admin #95–#97 | `PUT /me/tier` creates a tier request (202) rather than changing the tier; or allow only upgrades to Tier 1/2 without review. Needs product call |
| X-2 | **Pagination envelopes** | Mobile: cursor, `{data, meta:{limit,nextCursor,counts}}`. Web: page, `{items, page, perPage, total}`. Admin: page, `{data, meta:{page,pageSize,total,counts}}`. | All list endpoints | Internal cursor/page service; each DTO mapper picks the envelope. Never reuse a controller's response shape across clients |
| X-3 | **Identifier & reference formats** | Three order reference formats (`MB-2026-04871`, `MB-ORDER-33056`, `MB-BUY-/MB-SELL-nnnnn`); lots `MBV-…` (admin) vs `prd_`/`lot` (mobile/web); different ID prefixes per client. | Every resource | Store a single ObjectId + one internal `reference`; expose prefixed ids per client. Decide whether admin ids must equal customer references (ticket/dispute deep links) |
| X-4 | **Order model** | Mobile orders = buy-side; selling is `/sell/requests` and `/sell/bulk-quotes`. Web orders = buy **and** sell (`side`), and sell is `/listings`. Admin unifies both as a 6-stage Buy/Sell pipeline plus Bulk intake. | #41–#54 mobile, #35–#50 web, admin #23–#33 | One `Order` model with `side`; `SellRequest`/`Listing`/`BulkQuote` are intake documents that spawn an Order. Needs a data-model decision before any sell endpoint |
| X-5 | **Currency and money units** | Mobile: minor units + explicit `scale`; prefs USD/NGN/EUR/GBP. Web: minor units, no `scale`, ISO 4217. Admin: **major** units decimal, USD/KES/BTC. See ARCHITECTURE.md §6. | All money fields | Persist integers in minor units with an exponent table (incl. BTC=8); mappers convert. Need agreed currency list, BTC handling, and unit-price precision (mobile: integer minor per **gram**; admin: decimal major per **kg**, which cannot always be expressed in whole cents per gram) |
| X-6 | **Pricing ownership** | Mobile M-1 moves pricing server-side; admin owns rates (#47), manual overrides (#50) and firm-offer approval (#52). Web has its own quote endpoints (`/orders/quote` 1% fee, `/listings/quote` 2% fee) vs mobile 1.8% handling. | All quote endpoints | One pricing service reading admin-controlled rate + fee settings; fee percentages are per-client configuration |
| X-7 | **Status vocabularies** | Orders (mobile `verifying…delivered`, web `in_review/active/complete`, admin 6 stages); support tickets (mobile `agent_replied…`, admin `escalated/waiting_on_user`); KYC (see W-4); auctions (mobile `reserve_not_met`, web `unsold`, admin `paused/cancelled/draft`). | Orders, tickets, auctions, KYC | Internal canonical enums + per-client mapper; document each mapping table |
| X-8 | **Bidder identity** | Mobile M-9 undecided (trading name vs pseudonym); web mandates pseudonyms; admin shows linked-account markers. | #64 / web #53 | Pseudonyms for all customer clients until M-9 is answered |
| X-9 | **KYC & document lifecycle** | Mobile M-15/M-18 ask about expiry blocking and resubmission limits; admin has `Request resubmission`, document expiry monitor (#101) and `awaiting_resubmission`. | Mobile #25, #52, #83; admin #98–#101 | Policy values (grace days, max attempts) live in admin Platform Settings (#131/#132) |
| X-10 | **Deletion vs audit** | Mobile M-20 / web `DELETE /auth/account` (202 scheduled) vs admin audit log that records actions with actor and before/after values. | Account deletion, audit | Anonymise PII, keep audit and financial records; document retention periods |
| X-11 | **Hostnames and CORS** | Mobile `api.mineralbridge.co`, web `api.mineralbridge.com`, admin `api.mineralbridge.co.ke/admin/v1`. Cookie `SameSite=Strict` and CORS allowlists depend on same-site. | Deployment | Pick canonical API host(s); admin cookie `Path=/admin` stays valid only if admin lives under that path |
| X-12 | **Endpoint-count drift** | Mobile `GET /config/app` is documented but not in the 106; web needs a ws-token endpoint (W-1); admin lists 10 "recommended extras" outside the 139; admin `/files/{fileId}/url` vs web `/files/{fileId}` vs mobile multipart uploads. | Inventory counts | Inventory totals stay at 106 / 136 / 139 until these are approved; track additions separately |

---

## 5. Priority

**Decide before coding the shared infrastructure**
W-1 (`wsToken`), W-2 (CSRF), W-3 (cookie path), W-5 (client detection), W-4 / X-7 (status enums), X-5 (money / currency), X-2 / X-3 (envelopes and ids), X-4 (order model)

**Decide before the related module**
X-1 / M-19 (tier changes), X-6 / M-1 (pricing), M-8 / M-9 / X-8 (auctions), M-10 (bid deposits), M-12 (PIN), M-20 / X-10 (retention), A-1 (permission matrix), A-2 (step-up)

**Can ship with the proposed default**
M-2 … M-7, M-11, M-13 … M-18, A-3 … A-7, W-6 … W-14, X-9, X-11
