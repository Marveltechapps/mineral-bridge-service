# Dashboard, backend, and database integration report

Date: 2026-11-19. Local working tree only. No commit was created. No production document was inserted, updated, or deleted.

## Production readiness

Not production-ready. The section "Later the same day" replaces the earlier blocked-workflow and "still not verified" notes where they conflict.

The dashboard now reads and writes the v2 admin API against a real database for authentication, the console snapshot, customers, catalogue lots, auctions, settings, order search, and overview statistics. Several console actions still change only the in-memory screen. The process already listening on port 5001 was not restarted, so it does not yet serve the routing and cookie fixes until it is restarted. Legacy `orders` (79 documents) is a different collection from the v2 collection `cust_orders` (11 documents). The dashboard reads the v2 collection.

## Architecture

The admin console is the Vite app in `MB-Dashboard`. It keeps a `ConsoleDb` in memory and renders overview, orders, buy, sell, auctions, customers, support, notifications, catalogue, inventory, inspections, logistics, payments, refunds, documents, audit, and settings from that object.

`getConsoleDb()` now calls `GET /v2/admin/me` and `GET /v2/admin/console`. A 401 returns an empty console. Any other API error is thrown so the loading screen retries. The old seeded Nigeria dataset is used only when the database is not live and someone presses Reset demo data. A live session shows Reload records, which fetches the snapshot again.

The API is Express. Staff sign-in is `POST /v2/admin/auth/sign-in` with email and password. It sets the `mb_admin_session` cookie and returns `X-CSRF-Token`. Mutations require that header. The dashboard sends `X-Client: admin` and `credentials: 'include'`. Vite proxies `/v2` to the API. `VITE_API_URL` overrides the proxy target; otherwise it stays `http://localhost:5001`.

`/v2/admin` is mounted before `/v2`. The customer router ignores `/admin` and `/admin/*`, so an admin client is no longer rejected as a customer client.

Money in MongoDB is minor units. The snapshot converts those to major units for the console. Order stages are mapped from the v2 workflow keys onto the console stage list. A sell step stored as `ship` stays `ship` on write and displays at the console `picked` position.

## Database verification

Read-only ping of the configured database `mineral_bridge`: connected, `ping.ok = 1`, 165 collections, then disconnected. The check used `countDocuments` and `ping` only.

Collections the dashboard snapshot reads:

| Collection | Documents | Used by |
| --- | ---: | --- |
| users | 54 | Customers |
| cust_orders | 11 | Orders, buy, sell |
| cust_products | 136 | Catalogue |
| kycsubmissions | 6 | KYC queue |
| kycdocuments | 23 | KYC files (bytes are not copied into the snapshot) |
| cust_notifications | 13 | Notification list |
| cust_support_tickets | 2 | Support |
| audit_log | 61 | Audit |
| staffusers | 1 | Admin users |
| cust_payments | 0 | Incoming payments |
| cust_refunds | 0 | Refunds |
| cust_auctions | 0 | Auctions |
| cust_listings | 3 | Listings |

The older `orders` collection has 79 documents and `notifications` has 97. Those belong to the earlier admin models. They were not copied into the v2 collections.

Writes were proven on an in-memory replica set (`mb_dashboard_it` in Vitest, and `mb_dashboard_e2e` for the browser). The Atlas cluster was not used for those writes.

## Bugs fixed

1. Session cookie path was `/admin`, so a browser never sent it to `/v2/admin`. Requests whose URL starts with `/v2/admin` now get `Path=/v2/admin`. `/admin/v1` still uses `Path=/admin`. Isolated sign-in returned `Set-Cookie` with `Path=/v2/admin`. The existing admin suite still passed.
2. The customer router on `/v2` answered `/v2/admin/*` first and returned `request/client-invalid` for `X-Client: admin`. `/v2/admin` is now mounted first, and the customer router skips `/admin`.
3. The console was built entirely from seeded demo data, including after a settings reset. Live sessions load the database snapshot. Reset demo data no longer runs when `db.live` is true.
4. Sign-in accepted a demo role plus any 4-digit code. It now posts email and password to the staff API. WhatsApp sign-in tells the operator to use email and password.
5. Quote lines sent as minor units are stored as money objects (`label` + `amount`) on the order step. Assign-logistics resolves a partner by id or by name.
6. Console writes that have an API are persisted when the record is live: order step advance, order reject, customer suspend, refund status, and settings save. Customer create, update, reinstate, lot create, update, delete, auction delete, and settings patch exist on `/v2/admin` and are permission-checked. `ROLE-CEO` passes every action. Hard customer delete is not implemented; suspension is the supported action.

## Automated tests

Command: `npx vitest run` in `mineralbridge-backend`.

| | Count |
| --- | ---: |
| Passed | 370 |
| Failed | 0 |
| Blocked | 0 |
| Test files | 41 |

`tests/dashboard.integration.test.ts` is included in that run (3 passed). It uses mongodb-memory-server, not Atlas. It covers anonymous rejection, support-role 403 on payments, missing CSRF 403, customer create/rename/suspend/reinstate, lot create/list/delete rules, auction create/delete, settings patch, order search with `page` and `pageSize`, global search, overview KPIs, and the snapshot mapping (money, buy/sell stage, KYC words, customer role).

The first run of that file failed: anonymous console access returned 400 instead of 401, and CEO sign-in returned `request/client-invalid`. That was bug 2. The rerun passed. The full suite was then run once and passed, including admin auth, v2 HTTP, customer-admin bridge, trade flow, auctions, and order idempotency.

Dashboard `tsc -b --noEmit` passed before the browser pass. The only later dashboard edit was the Vite proxy reading `VITE_API_URL` from the process environment.

## Browser verification

The dashboard on `http://localhost:5173` was proxied to an API on `127.0.0.1:5011` whose database was the in-memory replica set. A CEO staff user was created only in that database. One customer, Isolated Buyer (`C-5001`), was created through `POST /v2/admin/customers` and then read back from `GET /v2/admin/console` (`live=true`, `source=database`).

Signed in through the password form as that CEO. The shell showed Platform CEO. No demo names appeared.

| Screen | Result |
| --- | --- |
| Sign-in | Password field and Sign in button. Session reached `/overview`. Pass |
| Overview | Live zeros: nothing waiting, $0 completed. Pass |
| Customers | Isolated Buyer, buyer, KE, pending KYC, active, 19 Nov 2026. 1 record. Pass |
| All orders | 0 records. Pass |
| Catalogue | 0 lots. Pass |
| Notifications | 0 records. Pass |
| Payments | 0 records. Pass |
| Refunds | 0 records. Pass |
| Auctions | 0 records. Pass |
| Support | 0 records. Pass |
| Audit | 0 records. Pass |
| Settings | Reload records is shown. Reset demo data is not. Pass |

Both test processes were stopped afterward. Port 5001 was left as it was found.

## Module results

| Module | Read | Write | Result |
| --- | --- | --- | --- |
| Authentication | Sign-in, cookie, CSRF, 401, 403 | Sign-out is wired | Pass |
| Overview statistics | API KPIs and browser zeros | — | Pass |
| Search, filters, pagination | Server search and `page`/`pageSize` on orders. Table filters run on the loaded snapshot | — | Pass |
| Customers | Snapshot and browser | Create, update, suspend, reinstate against the database | Pass |
| Orders | List, search, snapshot mapping | Step advance and reject are wired for live rows. Not clicked in the browser because the isolated database had no order | Blocked in the UI |
| Catalogue | Empty live list in the browser | Lot create, update, delete against the database. The new-lot form was not clicked | Pass on the API |
| Auctions | Empty live list | Create and delete against the database. The new-auction form was not clicked | Pass on the API |
| Settings | Reload label in the browser | `PATCH /settings` against the database. The save button was not clicked | Pass on the API |
| Payments | Empty live list. Support role forbidden | Confirm and reject are not persisted from the console | Blocked write |
| Refunds | Empty live list | Status post is wired for live rows. Not clicked | Blocked in the UI |
| KYC | Submissions are mapped into the snapshot | Approve / request changes from the console are not persisted | Blocked write |
| Notifications | Empty live list | Send and retry are not persisted | Blocked write |
| Support | Empty live list | Reply is not persisted | Blocked write |
| Documents and uploads | Issued documents are mapped. File bytes are omitted | Upload and reissue were not run | Blocked |
| Audit | Empty in the isolated browser. 61 rows exist in the configured database and are mapped with a 200-row cap | Append-only | Pass as a read |
| Inventory, inspections, logistics | Shipment, inspection, and partner fields are mapped when those documents exist | Partner edits and most holds stay in memory | Blocked write |

The snapshot returns at most 200 rows per collection. Dashboard tables then search, filter, and page that page in the browser. Server search remains available on `/v2/admin/search` and `/v2/admin/orders`.

## Counts

| Layer | Passed | Failed | Blocked |
| --- | ---: | ---: | ---: |
| Backend unit, API, integration, and workflow tests | 370 | 0 | 0 |
| Dashboard browser checks against the isolated database | 13 | 0 | 0 |
| Console workflows not driven, or not persisted | 0 | 0 | 8 |

The 8 blocked workflows are: order step/reject from the screen, refund transition from the screen, KYC decision, payment confirm/reject, notification send, support reply, document upload, and partner or hold edits. Customer, lot, auction, and settings writes were proven on the API even where the matching form was not clicked.

## What remains before production

- Restart the API so the cookie path and `/v2/admin` mount order are the process that browsers use.
- Persist the remaining console actions, or hide them while a record is live.
- Decide whether the 79 legacy `orders` documents should be shown. Do that with a reviewed migration, not by writing them into `cust_orders` ad hoc.
- Run one buy workflow and one sell workflow from the order screen against a non-production database.
- Exercise upload, notification delivery, and KYC decision on that same database.
- Confirm whether customer apps read the `platform` settings document. The settings screen still says changes apply to the customer app immediately. This pass only proved the admin snapshot stores them.

## Continuation — 19 Nov 2026, workflow persistence

The eight console writes that were blocked above now call real `/v2/admin` routes when the record is live. They were exercised against an in-memory replica set, not against the hosted database and not by clicking the dashboard buttons.

| Workflow | Route | Database result in `tests/desk.workflows.test.ts` |
| --- | --- | --- |
| Order step and hold | `POST /v2/admin/orders/:ref/steps/:step`, `POST /v2/admin/orders/:ref/hold` | Buy quotation moved the order to `confirmed` after the customer accepted it. A hold of type `changes` was set and then cleared. |
| Refund | `POST /v2/admin/refunds/:ref/transition` | `requested` → `under_review` → `approved` for a 1000-minor refund. |
| KYC | `POST /v2/admin/kyc/:id/decide` | Pending submission became `resubmission_required` with the reason stored. |
| Payment | `POST /v2/admin/payments/:ref/confirm` and `/reject` | Confirm stored `confirmed` and `TRX-DESK`. Reject stored `failed`. |
| Notification | `POST /v2/admin/notifications/:id/retry` | A failed delivery became `delivered`. A second retry returned 409 `notification/not-failed`. |
| Support | `POST /v2/admin/support/:ref/reply` and `/status` | Two agent replies were stored, then the ticket became `resolved`. |
| Document | `POST /v2/admin/documents/upload`, `GET /documents/:number/download`, `POST /documents/:number/reissue` | Uploaded PDF bytes were downloaded unchanged. Reissue marked the previous row `replaced` and left one `issued` row. |
| Partner, shipment, inventory | `POST/PATCH /v2/admin/partners`, `PATCH /shipments/:ref`, `POST /catalogue/lots/:ref/hold` | Partner `PT-…` was created. Deleting it returned 409 because a shipment referenced it. Shipment location `Mombasa Road` and status `in_transit` were stored. Lot hold set and cleared `attributes.onHold`. |

`npx vitest run tests/desk.workflows.test.ts` on 19 Nov 2026: 3 passed, 0 failed. That file also checks the legacy-order planner against a fixture: the source `orders` row stays, the `cust_orders` copy carries `migration.batch`, and reversal deletes only that marked copy.

Sell review was included. The order starts at `reviewed`, the admin step advances it to `quote`, the offer is stored, and the seller accept moves it to `confirmed`. The later sell steps (contract, inspection, SGS, payout, shipment, delivery) and the later buy steps (contract signature, customer payment submission, logistics, receipt, completion) were not walked as one order.

### API process

The process listening on port 5001 is PID 12424, started 19 Nov 2026 12:10:39, command `tsx src/server.ts`. It was already the current source, so it was not killed again. `GET /v2/admin/health` with `X-Client: admin` returned 200 `{"status":"ok","api":"v2/admin"}`. An anonymous `GET /v2/admin/console` returned 401 `auth/session-expired`.

### Legacy orders

`node --import tsx scripts/migrate-legacy-orders.ts` against the configured database, dry-run only: scanned 79, would insert 79, skipped 0, batch `legacy-2026-11-19`. `hostedWriteBlocked` was true. No insert, update, or delete was sent. `totalDue` is planned as major units and the original value is kept on `migration.totalDueOriginal`. The 13 `adm_orders` documents were not copied; their stage names are the admin desk vocabulary, not the v2 step keys.

### Customer-facing fixes in this pass

- `GET /v2/reference/payment-methods` and `/payment-instructions` read the `platform` settings document, with environment values as the fallback. The desk test received `bank_transfer` enabled.
- Auction opening and ending notifications use distinct mobile kinds. A KYC decision of `rejected` maps to `kyc_rejected`, and `resubmission_required` maps to `kyc_resubmission`.
- The customer order detail already returns the quotation block. Profile OTP and the inspection screen in the mobile app were not opened.

### Later the same day

The notes above are the earlier pass. This section replaces them where they conflict.

`npx vitest run tests/full-workflows.test.ts` passed (1 test, in-memory replica set `mb_full_flow`). It walked a buy order from `createBuy` through quotation, customer accept, price lock, contract hash/sign/countersign, BTC quote and submit, finance confirm, shipment, pickup, transit, delivery, and customer receipt (`status` `completed`, step `done`). It walked a sell order through review, quote, accept, contract, seller form, inspection, SGS certificate `SGS-FLOW-1`, seller acceptance, payout, ship, delivery, and `completed`. The same test created an auction, saved a document template to version 2, invited a staff user and signed that user in with the returned temporary password, issued a `tax_invoice`, and checked console `pageSize=1` returns one order while `totals.orders` is at least 2. A BTC submit bug (second active payment on the same order) was fixed by updating the initiated quote in place; the rerun passed.

`node --import tsx scripts/sample-legacy-amounts.ts` was read-only. Of the 79 legacy `orders` rows, 57 have `totalDue` (major units: min 23.5, median 1947.4, max 813250, 23 of them have decimals). `amount` is never a finite number. 22 rows have no `totalDue`. The planner now skips those 22, unknown units, and non-finite amounts, and converts `MT` through the commercial unit table. A later dry-run reported scanned 79, would insert 57, skipped 22 (`missing totalDue`), batch `legacy-2026-11-19`, `hostedWriteBlocked: true`. Nothing was written. No backup was taken because no write was attempted. The 13 `adm_orders` rows were not mapped and were not touched.

Console reads are paged (`page`, `pageSize`, default 50, max 100) and the dashboard walks pages of 100. Tables page 25 rows in the browser. Auction create, template save, admin invite, and invoice generate call the API when the record is live. Settings copy now says only payment methods and receiving-bank details are read by the customer app. Payment-method toggles call the settings save.

ESLint was already installed. Backend `npm run lint` exited 0 with 77 warnings and 0 errors. Backend `npm run build` exited 0. Dashboard `npm run lint` then `npm run build` exited 0. The dashboard bundle warning is that the main chunk is about 666 kB.

### Browser clicks against the isolated API (port 5011, not Atlas)

The dashboard at `http://127.0.0.1:5173` was signed in as the isolated CEO. After the clicks, `GET /v2/admin/console` on that same API returned:

| Click | Stored result |
| --- | --- |
| Issue buy quotation on `MB-ORD-ISO-1` | Workflow `quoteOk`, quotation version 2, USD 50.00 |
| Shipment location `Mombasa Road` | Location and status text stored |
| Confirm payment `TRX-ISO-UI` on `MB-ORD-ISO-PAY` | Payment confirmed, step `assigned` |
| Support reply on `TCK-ISO-1` | Agent reply stored (the reply was sent twice) |
| Refund `MB-RF-ISO-1` review then approve | `refund` status `approved` |
| KYC `MB-KYC-ISO-1` request documents | `kyc` status `requested` |
| Notification retry on "Payment update" | delivery status `delivered` |
| Catalogue "Hold stock" on `LOT-ISO-1` (earlier attempt) | `onHold` stayed `false` — form state was not reaching the API |

Document upload was not clicked in that earlier pass because it needs a file chooser.

### Blocker fixes — later the same day (19 Nov 2026)

#### 1. Hold stock and documents

- Drawer inputs are now controlled React state so typed values stay in `c.form`.
- Hold stock requires ≥3 characters and posts `hold` + `reason`; the service saves `attributes.onHold` / `holdReason` with `markModified` and audit.
- Live “New document” uploads a file via `POST /v2/admin/documents/upload` (orderRef). Upload / download / reissue remain wired for live docs.
- **Browser evidence (isolated 5011):** Hold stock → console showed `LOT-ISO-1` `onHold: true`, reason `Reserved for inspection`. Document `CN-ISO-1` upload returned `fileId`; download returned `%PDF-1.4`. Documents drawer shows Upload file and Download.

#### 2. Hosted migration (blocked pending approval)

- Read-only backup written to `backups/orders-2026-11-19T08-39-23-755Z/` with `orders` 79, `adm_orders` 13, `cust_orders` 11. Manifest says no MongoDB writes.
- Mapping notes: `docs/Adm_Orders_Mapping.md`. Dry-run still: would insert 57, skip 22 (`missing totalDue`), `hostedWriteBlocked: true`.
- **No hosted write.** Needs explicit approval. Do not invent prices for the 22. Do not touch `adm_orders` without a verified row mapping.

#### 3. Dashboard buy / sell (partial UI + full service E2E)

| UI action (isolated 5011) | Mongo / API result |
| --- | --- |
| Buy `MB-ORD-ISO-1` Issue quotation | `workflow.stepKey` `quoteOk` |
| Payments Confirm `TRX-ISO-UI-2` on `MB-ORD-ISO-PAY` | payment `confirmed`, step `assigned` |
| Sell `MB-ORD-ISO-SELL` Mark reviewed | step `quote` |
| Sell offer (API after qty fix; same payload as UI) | step `quoteOk`, quoted `USD 25.00` |

Sell quotation had failed with `lines.0.qty` required when `order.sell.qty` was missing. Fixed in `admin-orders.service.ts` to fall back to line qty / `totalGrams`. Rerun: `desk.workflows` 3/3 and `full-workflows` 1/1 passed.

Full buy/sell through contract → payment → inspection → payout → delivery → completion remains proven by `tests/full-workflows.test.ts` on an in-memory replica set, not by clicking every customer-owned step in the Dashboard, and not against Atlas.

#### 4. Mobile emulator

- Debug `DEV_PORT` set to **5011** (isolated). `adb reverse tcp:5011` applied.
- `com.mineralbridge` launched to the Create account / Sign in / Browse as guest screen.
- Emulator then showed **Pixel Launcher isn’t responding** (ANR). Login, OTP, orders, payments, documents, support, and inspection were **not** completed on device.
- Mobile `tsc --noEmit` and Jest: 2 suites, 38 tests passed. `react-native run-android --appId com.mineralbridge.app` built but failed to start the wrong activity class.

#### 5. Automated suite

| Check | Result |
| --- | --- |
| `npx vitest run` (backend) | **43 files, 374 tests passed** |
| `tests/desk.workflows.test.ts` + `full-workflows.test.ts` after sell qty fix | 4 passed |
| Backend `npm run lint` | 0 errors, **77 warnings** (mostly unused eslint-disable) |
| Backend `npm run build` | exit 0 |
| Dashboard lint + build | exit 0 (~668 kB chunk warning) |
| Mobile typecheck + Jest | exit 0 |

### Still blocked / incomplete

#### Backup + migration preview (no write)

- Backup verified: `backups/orders-2026-11-19T08-39-23-755Z/` — orders **79**, adm_orders **13**, cust_orders **11**, recoverable JSON. See `docs/Backup_Verification.md`.
- 57-row preview: `docs/Legacy_Orders_Migration_Preview.md` (+ `.json`) with `totalDueOriginal` and `amountMinor`. 22 skipped (`missing totalDue`). **No migration executed.**

#### Eight workflows + customer accept (isolated :5011)

Hold, buy quote, payment `TRX-EIGHT-1`, refund approved, KYC requested, notification delivered, support reply, document upload/download, shipment location, sell quote → customer OTP accept → sell `confirmed`. ESLint `src`/`tests`: **0 problems**. Backend/dashboard builds exit 0. Desk+full workflow tests: 4 passed.

#### Still blocked

1. **Hosted migration write** — waiting for your approval after the 57-row review.
2. **Full Dashboard UI buy/sell through completion** — customer-owned desk clicks through delivery incomplete.
3. **Mobile on-device E2E** — emulator still shows **System UI isn’t responding**; splash only.
4. Isolated/memory results are **not** hosted Atlas proof.
