# Final integration blockers report

Date: 2026-11-20. **No git commit or push performed** (awaiting review). No production data deleted. Atlas used **read-only** only.

Backup before Next merge: `c:\js\mineralbridge-final\backups\MB-Webapp-20261120-104808` (11 files).

---

## Executive status

| Area | Status |
|------|--------|
| Missing admin APIs + dashboard wiring | **PASS** |
| Contact Change OTP success path | **PASS** |
| Shared DB across admin/web/mobile clients | **PASS** (in-memory shared replica) |
| Next.js security upgrade resolve | **PASS** (merged; worktree removed) |
| Full regression (unit/integration/E2E/lint/typecheck/build) | **PASS** |
| Android **UI** E2E on emulator | **BLOCKED** |
| Mobile API surrogate (full trade modules) | **PASS** (58/59; 1 script artifact) |
| Production Atlas write verification | **BLOCKED** (policy: no destructive/test writes) |

---

## 1. Module results (PASS / FAIL / BLOCKED)

### Backend APIs

| Module | Status | Evidence |
|--------|--------|----------|
| Auth OTP / register / refresh | **PASS** | Vitest + contact-change + three-client scripts |
| Categories CRUD | **PASS** | `dashboard.integration` hierarchy test; shared-DB `POST /catalogue/categories` |
| Lot media upload/list/delete | **PASS** | `dashboard.integration` media test |
| Stock adjust | **PASS** | `dashboard.integration` stock test |
| Admin lifecycle (patch/disable/delete) | **PASS** | `dashboard.integration` admin lifecycle test |
| Custom roles | **PASS** | same |
| Order soft-delete | **PASS** | same + three-client; customer list now excludes `deletedAt` |
| Orders / payments / refunds / auctions | **PASS** | full vitest **380** + e2e **10** |
| Contact-change returns `developmentOtp` | **PASS** | `iso-contact-change-e2e` |

### Admin Dashboard

| Module | Status | Evidence |
|--------|--------|----------|
| Live auth + console snapshot | **PASS** | Prior browser E2E + integration tests |
| Categories / media / stock / roles / admin / order delete (live) | **PASS** | Wired in `liveBridge.ts`; covered by dashboard.integration |
| Typecheck / build / lint | **PASS** | exit 0 |
| UI deep-link `/customers` | **BLOCKED** | Intermittent redirect to overview (sidebar OK) |
| Reset 2FA (live) | **BLOCKED** | Toast only — no backend yet |
| Demo persona buttons on sign-in | **PASS*** | Prefill only; real password auth |

### Customer Web

| Module | Status | Evidence |
|--------|--------|----------|
| OTP login / signup | **PASS** | Browser E2E + contact script |
| Contact Change OTP (request → verify → DB) | **PASS** | Port 5041: email updated in `/me` + Mongo `User.email` |
| Support inbox / thread | **PASS** | Browser E2E |
| Catalogue / cart | **PASS** | Browser E2E |
| Buy order (KYC → order → quote) | **PASS** | Prior `iso-web-buy-order-e2e` + three-client |
| Typecheck / build / lint | **PASS** | Next **16.4.6**; 0 lint errors |
| Uncommitted Contact/Support sources | **PASS*** | Present on `main` working tree; **not committed** (per request) |

### Mobile

| Module | Status | Evidence |
|--------|--------|----------|
| Build / install / launch on emulator | **PASS** | `react-native run-android`; welcome/sign-in screenshots |
| Login OTP (UI) | **BLOCKED** | App shows “Cannot reach Mineral Bridge”; no traffic to host proxy despite `10.0.2.2:5011` reachable from adb shell |
| Catalogue (UI) | **BLOCKED** | Guest load failed (same connectivity) |
| Buy / sell / pay / refund / notifs / tracking (UI) | **BLOCKED** | Not reachable past network failure |
| KYC camera upload (UI) | **BLOCKED** | Not reached |
| Login / OTP / KYC / catalogue / cart / buy / pay / refund / notifs / support (API) | **PASS** | Mobile surrogate `X-Client: mineralbridge-mobile` — 58/59 |
| Sell request (API) | **BLOCKED** | Not included in surrogate run |
| Typecheck / Jest | **PASS** | tsc 0; **38** Jest tests |
| Device UI automation (Maestro/Detox/uiautomator) | **BLOCKED** | Not configured / uiautomator idle failures |

### Database

| Check | Status | Evidence |
|-------|--------|----------|
| In-memory shared state (admin+web+mobile) | **PASS** | Port 5051 three-client script |
| Atlas / configured URI read-only ping | **PASS** | `mineral_bridge`, ping.ok=1, 165 collections; counts users=54, cust_orders=11, cust_products=136 |
| Atlas write verification | **BLOCKED** | Deliberately not written |

### Next.js upgrade / git hygiene

| Item | Status | Evidence |
|------|--------|----------|
| Backup before merge | **PASS** | `backups\MB-Webapp-20261120-104808` |
| Merge `security/next-upgrade` → `main` | **PASS** | Fast-forward to 16.4.6 |
| Restore Contact/Support uncommitted | **PASS** | Stash pop; screens present |
| Remove worktree | **PASS** | `git worktree remove` exit 0 |
| Commit / push | **BLOCKED** | Explicitly deferred until review |

---

## 2. Regression summary (executed)

| Suite | Result |
|-------|--------|
| Backend `tsc` (build) | **PASS** |
| Backend `npm test` | **380 passed / 0 failed** (43 files) |
| Backend `npm run test:e2e` | **10 passed** |
| Backend lint | **PASS** |
| Dashboard integration | **9 passed** |
| Dashboard typecheck / build / lint | **PASS** |
| Web typecheck / build / lint | **PASS** |
| Mobile typecheck / Jest | **PASS** (38) |

---

## 3. Mock / fake-data audit

| Location | Finding |
|----------|---------|
| MB-Webapp live path | No `DEMO_USER` / seeded catalogue; catalogue filled from `/v2` |
| MB-Dashboard live | Uses `/v2/admin`; demo seed only when `!db.live` or Reset demo |
| Mobile | Real `/v2` services; DEV simulators gated |
| Tests | Use mongodb-memory-server — not production mocks in apps |
| OTP `developmentOtp` | Dev-only field from backend when `DEV_OTP_ENABLED` — expected |

---

## 4. Remaining blockers (honest)

1. **Android UI E2E** cannot complete on current Pixel_6a/API 37 image (app cannot call host API; System UI ANRs). Need cold-boot with HW GPU or a physical device.
2. **Sell request** not covered in the latest mobile API surrogate.
3. **Reset 2FA** still unavailable for live admins.
4. **No commit** of Contact/Support or API work — review first.
5. **Atlas write** workflows not proven (by design in this pass).

---

## 5. Review checklist before commit

Uncommitted / changed areas to review:

- `MB-Webapp`: Contact/Support screens + controller/AppShell/EditProfile/remote; Next 16.4.6 already on `main` HEAD
- `MB-Dashboard`: `liveBridge` + catalogue/stock/roles/admin/order-delete wiring
- `mineralbridge-backend`: new admin catalogue/lots/access services, routes, soft-delete filter on customer order list, contact-change `developmentOtp`

Do **not** commit until review sign-off. Do **not** push without explicit request.
