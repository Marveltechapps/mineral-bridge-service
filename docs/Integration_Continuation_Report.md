# Integration continuation report

Date: 2026-11-20. Local working tree only. No production (Atlas) writes for verification.

## Production-readiness

**Closer to staging-ready, still not a production cutover.** Live dashboard mutations, web Contact Change OTP + Support Inbox, Next.js 16.4.6 security upgrade, and browser E2E against in-memory APIs all executed successfully. Remaining gaps are listed at the end.

---

## 1. Dashboard actions: local vs live

### Now persisted when `db.live` (newly wired this pass)

| Action | API |
|--------|-----|
| New buy / sell order | `POST /v2/admin/orders` |
| New refund / refund edit | `POST` / `PATCH /v2/admin/refunds` |
| Partner delete | `DELETE /v2/admin/partners/:id` |
| Order hold / clear / changes | `POST …/orders/:ref/hold`, `…/changes` |
| Price variation | `POST …/orders/:ref/price-variations` |
| Auction pause / resume / cancel / close / winner order | `…/transition`, `…/finalize`, `…/order` |
| Auction extend 1 hour | `POST /v2/admin/auctions/:id/extend` (**new**) |
| Lot min order + reference price | `PATCH …/catalogue/lots/:ref` (extended) |
| Confirm payment (Record payment UI) | `POST …/payments/:orderRef/confirm` |
| New support conversation | `POST /v2/admin/support` (**new**) |
| Send manual notification | `POST /v2/admin/notifications` (**new**) |
| Console order quotes | Snapshot now loads `QuotationModel` into `o.quotes` |

### Still local-only or intentionally client-only

| Action | Notes |
|--------|-------|
| Theme (`mb4-theme`) | localStorage UI preference |
| Demo reset / Simulate customer / Simulate 2nd approver | Dev/demo only when `!live` |
| Order hard delete / free-form order edit | No admin delete/patch API |
| Manual KYC create; per-doc KYC media | Submission-level decide only |
| Catalogue categories CRUD; master sheet; lot media; stock ledger | No write APIs |
| Admin edit/disable/delete; custom roles | Invite only |
| Client `V.log` / `V.tell` rows | Server audit/notifications are authoritative |
| Offline “create payment without buyer submit” | Live UI confirms submitted payments only |

---

## 2. Customer Web: Contact Change OTP + Support Inbox

| Item | Status |
|------|--------|
| `ContactOtpScreen`, `SupportInboxScreen`, `SupportThreadScreen` | Added |
| `AppShell` + `controller` wiring | Done |
| Edit profile Change → OTP | Done (browser E2E) |
| Help → Support inbox | Done (browser E2E) |
| Backend returns `developmentOtp` on contact-change | **Fixed** in `v2.me.controller.ts` (was omitted) |

---

## 3. Next.js security upgrade (separate worktree)

| Item | Detail |
|------|--------|
| Reason | Monorepo root had no git; `MB-Webapp` was initialized so a worktree could be used without touching other packages mid-upgrade |
| Worktree | `c:\js\mineralbridge-final\MB-Webapp-security-upgrade` branch `security/next-upgrade` |
| Version | **16.4.1 → 16.4.6** |
| Config | `experimental.agentUpgrade: 'security'` in `next.config.ts` |
| Verified in worktree | `next --version` = 16.4.6; typecheck PASS; `next build` PASS |
| Synced into main checkout | `package.json`, `package-lock.json`, `next.config.ts` copied; `npm install` → Next 16.4.6; main build PASS |
| Commit on worktree | `2499e3a` — original `main` branch files for Contact/Support remain uncommitted on the main checkout |

Merge into main when ready:

```bash
cd MB-Webapp
git merge security/next-upgrade
# then commit Contact/Support feature files on main
```

---

## 4. Browser E2E (executed)

Isolated API `:5031` (memory Mongo), dashboard `:5173`, web `:3100`. Script: `scripts/iso-browser-e2e-server.ts`. No Atlas.

| Step | Result |
|------|--------|
| Dashboard CEO sign-in | **PASS** |
| Live customers / catalogue / support | **PASS** |
| Create customer via UI + reload | **PASS** |
| Web OTP sign-in | **PASS** |
| Help → Support inbox + thread | **PASS** |
| Edit profile → contact OTP (wrong code) | **PASS** |
| Buy → lot → cart | **PASS** |
| Mobile API surrogate (`X-Client: mobile`) | **PASS** |
| Mobile device / emulator UI | **NOT EXECUTED** |

Screenshots under `%TEMP%\cursor\screenshots\` (`dash-01-*`, `web-01-*`, …).

---

## 5. Automated tests re-run (executed)

| Check | Result |
|-------|--------|
| Backend `tsc -p tsconfig.build.json --noEmit` | **PASS** |
| Backend `npm test` | **375 passed / 0 failed** (43 files) |
| Backend `npm run test:e2e` | **10 passed** |
| Backend lint | **PASS** |
| Dashboard typecheck / build / lint | **PASS** |
| Webapp typecheck / build | **PASS** (Next 16.4.6) |
| Webapp lint | **PASS** (0 errors, 29 pre-existing a11y warnings) |
| Mobile typecheck | **PASS** |

Also fixed: `admin-orders.service.ts` used invalid `wf.currentKey` → `wf.current.key` (blocked production tsc).

---

## 6. Issues fixed this pass

1. Wired remaining dashboard live actions to existing `/v2/admin` APIs (+ support/notification create).
2. Auction extend endpoint + UI.
3. Console snapshot quotes from DB.
4. Record/Confirm payment uses `POST …/payments/:orderRef/confirm` when live.
5. Contact-change response now includes `developmentOtp` / `resendAvailableAt` in development.
6. Next.js security upgrade 16.4.6 in worktree, synced to main webapp.
7. Workflow `currentKey` TypeScript bug.

---

## 7. Remaining blockers

1. **Mobile device E2E** not run (no emulator/session).
2. **Contact-change success path** in browser was only partially proven before the `developmentOtp` fix; wrong-code path passed. Re-run success path recommended.
3. **Dashboard deep-link** `/customers` redirected to `/overview` once (sidebar navigation works).
4. **Catalogue race** after restart (empty categories until reload) — intermittent, not reproduced reliably.
5. **Still no APIs** for: category CRUD, lot media, stock ledger, admin lifecycle beyond invite, custom roles, order hard-delete.
6. **Demo persona buttons** still appear on dashboard sign-in (email prefill only; auth is real).
7. Worktree `security/next-upgrade` is separate from uncommitted Contact/Support files on `MB-Webapp` `main` — merge/commit when ready.
8. Production Atlas / real OTP providers / cookie secure flags not exercised in this pass.

---

## 8. Assessment

The stack is **integration-verified for staging** on in-memory databases: dashboard live writes, web auth/support/contact OTP/cart, and backend suites are green. **Do not declare production-ready** until mobile device E2E, contact-change success re-check, production env hardening, and product decisions on the remaining local-only admin surfaces.
