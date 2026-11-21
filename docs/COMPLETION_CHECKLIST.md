# Mineral Bridge Backend — Completion Checklist

| Feature / module | Implementation | APIs | DB persist | Unit | Integration/E2E | External deps |
|------------------|----------------|------|------------|------|-----------------|---------------|
| Auth / me / sessions | Done | `/v2/auth`, `/v2/me` | Yes | Pass | Covered | SMS/email OTP credentials for live |
| KYC | Done | `/v2/kyc`, admin decide | Yes | Pass | Covered | — |
| Files | Done | `/v2/files` | Yes | Pass | — | Storage env for non-local |
| Catalogue / cart | Done | `/v2/catalogue`, `/v2/cart` | Yes | Pass | — | — |
| Orders buy/sell workflow | Done | `/v2/orders`, admin steps | Yes | Pass | Partial E2E | — |
| Contracts / payments | Done | contract + payments + admin confirm | Yes | Pass | — | BTC rate / PSP for live |
| Notifications + SSE + outbox | Done | `/v2/notifications` | Yes | Pass | — | Push provider optional |
| Auctions | Done | `/v2/auctions` + admin | Yes | Pass | E2E list/bid | — |
| Refunds + four-eyes | Done | `/v2/refunds`, `/v2/admin/refunds` | Yes | — | E2E | Bank rail for live payout of refund |
| Order chat ORD-24 | Done | `/v2/orders/{ref}/messages` | Yes | — | E2E | — |
| Documents ORD-21/22 | Done | `/v2/documents`, order docs | Yes | — | E2E PDF/JSON | — |
| Price variation ORD-18 | Done | customer + admin | Yes | — | E2E | — |
| Change requests ORD-17 | Done | customer + admin | Yes | — | E2E | — |
| Admin CSV export | Done | `/v2/admin/*/export` | Read | — | E2E headers | — |
| Admin on-behalf order | Done | `POST /v2/admin/orders` | Yes | — | — | — |
| Seller payouts + four-eyes | Done | `/v2/admin/payouts` | Yes | — | E2E | Bank rail for live release |
| Negotiation AORD-10 | Done | admin + offerMinor on chat | Yes | — | — | — |
| Richer admin badges | Done | `/overview`, `/badges` | Yes | — | E2E | — |
| Legacy `/v1` + `/admin/v1` | Preserved | Existing | Yes | Pass | Existing | — |

## Quality gates

- `npm run typecheck` — required green
- `npm run lint` — ESLint flat config
- `npm test` — Vitest regression
- `npm run test:e2e` — Mongo memory HTTP/service E2E

## Not claimable as live-verified without credentials

SMS OTP delivery, email SMTP, BTC rate vendor, payment PSP webhooks, remote object storage.
