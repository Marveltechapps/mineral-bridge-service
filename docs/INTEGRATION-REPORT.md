# Mineral Bridge integration report

Date: 2026-10-17. Local working trees only. No commit, push, merge, rebase, or branch switch was performed.

## What was implemented

- Customer orders, accounts, and KYC submissions are projected into the admin collections the dashboard reads (`adm_users`, `adm_kyc_submissions`, `adm_orders`). An admin order stage change is written back onto the customer order with the same reference. An admin KYC decision is applied to the customer submission when that submission exists.
- Catalog sync reads a Google Sheet CSV, validates rows, and upserts by a stable source key. A failed or HTML/sign-in response does not write the database. The live sheet returned HTTP 401, so no minerals were imported.
- OTP and email providers now recognise the credentials already named in the environment: Twilio SMS and WhatsApp from-numbers, SpearUC vendor URL, and Resend. Delivery is success only when the provider accepts the request. Fake providers and `OTP_TEST_OTP` are refused when `NODE_ENV=production`.
- Web catalog and web OTP, dashboard sign-in/OTP/orders, and mobile OTP call the real API when a base URL is set. Empty base URL keeps the existing demo path.
- Production boot checks cookies, secrets, debug mode, and fake providers before opening a database connection.

## Verified commands

| Check | Result |
| --- | --- |
| Backend `tsc --noEmit` | Pass |
| Backend `npm run build` | Pass. Output is `dist/server.js` |
| Backend `npm start` with the current `.env` | Exits before listen. Refuses fake OTP, fake email, `COOKIE_SECURE=false`, short/dev secrets, `OTP_TEST_OTP`, and `DEBUG_MODE` |
| Backend Vitest (full tree, including a nested worktree that has since been excluded) | 518 passed, 1 failed. The failure was the catalog parser treating `not-a-price` as `0`. Fixed. Targeted rerun of sheet, bridge, email, and production-guard tests: 12 passed |
| Web `npm run typecheck` | Pass |
| Dashboard `npm run typecheck` | Pass |
| Mobile `tsc --noEmit` | Pass |
| `npm run catalog:sync` | Exit 2. Spreadsheet HTTP 401. Database not contacted |
| `docker compose config` | Valid after the `.env` banner line was commented. Containers were not started |
| `npm run seed` | Not run. The configured URI is a hosted database |
| Backend ESLint | Not runnable. ESLint is not a project dependency and there is no config file |
| GitHub Actions | Workflow file added. Not executed, because nothing was pushed |

## Catalog

The workbook is now readable. gid `329767875` is only the index. The mineral catalog is the SKU tab, gid `1332939829`, columns Mineral ID, Sub Category Name, Mineral Name, Category, Product Description, Primary Image, Price, Unit, Availability.

Parsed locally from that tab: 143 source rows, 136 accepted minerals, 7 section headers skipped, 0 invalid. Categories: Critical Mineral, Gemstone, Industrial Mineral, Precious Metal, Energy Mineral (46 subcategories). Every accepted row has an https image URL. A server-side check of those URLs: 91 responded as images, 45 returned HTTP 403. Those 45 URLs are still stored as the sheet gave them; they were not replaced.

MongoDB was not updated. Connecting with the configured Atlas URI failed before any write: `querySrv ECONNREFUSED`. No catalog records were inserted.

## OTP and email

Code paths exist for Twilio, SpearUC, Resend, SMTP, and the fake test provider. No live SMS or email was sent. Provider acceptance was not observed. Do not treat delivery as verified.

`OTP_PROVIDER` and `EMAIL_PROVIDER` in the local `.env` are still `fake`. They were left that way so this work would not send real messages. Production startup now refuses that combination.

## Security notes

Fixed in this change: production refuses fake OTP/email, insecure cookies, weak secrets, fixed test OTP, and debug mode; Swagger is hidden in production unless `ENABLE_API_DOCS` is set; web cookie mutations require `X-Client` or `X-Requested-With` in production; dashboard mutations send `X-CSRF-Token`; sheet sync and providers do not log vendor URLs or message bodies.

Not claimed safe: dependency advisories remain (backend: vitest/tinypool critical in dev, yaml moderate; dashboard install reported 21 advisories). Admin and customer records for auctions, wallets, sell requests, and listings are still separate collections. A full external security review is still required.

Credential categories that should be rotated, because they were present in local env and earlier tool output: MongoDB password, AWS access key, Resend API key, Twilio auth token, SMS vendor password, and the JWT/admin/websocket secrets before any real production start. Values are not repeated here.

## API request behaviour

No browser HAR was captured. Demo mode (empty base URL) still makes zero API calls.

When a base URL is set:

- Web catalog: one `GET /lots` per filter change. The previous request is aborted.
- Web auth: one register or OTP request, then one verify.
- Dashboard auth: one sign-in, then one OTP verify.
- Dashboard orders: one list on load and again after a successful advance, plus one advance POST. There is no poll loop.

## Deployment and rollback

1. Set `NODE_ENV` to `development` for local work, or replace every item the production guard names before using `production`.
2. Set `OTP_PROVIDER` to `twilio` or `spearuc` and `EMAIL_PROVIDER` to `resend` or `smtp` only when a real send is intended.
3. Unset `OTP_TEST_OTP` and `DEBUG_MODE`. Set `COOKIE_SECURE=true` behind HTTPS.
4. Customer apps: base URL must include `/v1`. Dashboard: host only; the client prefixes `/admin/v1`. Dashboard origin must be in `CORS_ADMIN_ORIGINS` (local `.env` now includes port 5190).
5. Share the catalog sheet or set `CATALOG_SHEET_CSV_URL`, then run `npm run catalog:sync`.
6. Start with `npm run build` and `npm start`, or `docker compose --profile full up`. The current `.env` will refuse to boot in production until the guard items are fixed. That refusal is intentional.
7. Rollback: these changes are uncommitted. Restoring the previous files on the current branches returns the previous behaviour. Do not drop the local `.env`; it is gitignored and contains the real configuration.

## Still demo or blocked

Dashboard screens other than sign-in and orders still render bundled fixtures. Mobile screens other than OTP still navigate the design flow. Web cart, KYC, orders, wallet, and auctions are not switched to the API. Customer KYC approval is wired on the server and covered by the existing admin KYC tests not failing, but there is no new HTTP test that creates a customer submission and reads it back from the dashboard API.
