# Mineral Bridge API Contract (implemented)

## Surfaces

| Prefix | Clients |
|--------|---------|
| `/v1` | Legacy mobile/web (preserved) |
| `/admin/v1` | Legacy admin (preserved) |
| `/v2` | Customer mobile + web (`X-Client: mobile\|web`) |
| `/v2/admin` | Admin dashboard (`X-Client: admin` + staff session + CSRF) |

## Customer `/v2` (implemented)

| Module | Endpoints |
|--------|-----------|
| Auth | `POST /v2/auth/otp/*`, `/register`, `/refresh`, `/logout`, `/sessions` |
| Me | `GET/PATCH /v2/me`, contact-change, business-type, summary, notification-preferences |
| KYC | `GET/PATCH /v2/kyc`, documents, submit |
| Files | `POST /v2/files`, `GET /v2/files/:id/url` |
| Catalogue | `/v2/catalogue/categories`, `/products`, `/products/:ref` |
| Cart | `GET /v2/cart`, `PUT/DELETE /v2/cart/items/:productRef` |
| Orders | create/list/get, quotation accept/decline, contract, payments, seller-form, inspection, receipt, cancel, shipment |
| Order chat (ORD-24) | `GET/POST /v2/orders/{ref}/messages` (optional `offerMinor`) |
| Changes (ORD-17) | `POST /v2/orders/{ref}/changes` |
| Price variation (ORD-18) | `POST /v2/orders/{ref}/price-variations/{variationId}` |
| Refunds (RFD-01) | `POST /v2/orders/{ref}/refunds` · Idempotency-Key |
| Documents (ORD-21/22) | `GET /v2/orders/{ref}/documents`, `GET /v2/documents/{number}?format=json\|pdf` |
| Auctions (AUC-01…06) | `GET /v2/auctions`, `/{ref}`, `/{ref}/bids`, `POST …/bids`, auto-bid, reminder, `POST …/order` |
| Refund list (RFD-02/03) | `GET /v2/refunds`, `GET /v2/refunds/{ref}` |
| Notifications | `GET /v2/notifications`, read, read-all, **SSE** `GET /v2/notifications/stream` |
| Devices | `POST/DELETE /v2/devices` |
| Support | FAQs, threads, messages |
| Reference | `GET /v2/reference/:list` |

Headers: `X-Client: mobile|web`. Bearer access token on protected routes. Web refresh cookie `mb_refresh` path `/v2/auth`.

## Admin `/v2/admin` (implemented)

| Module | Endpoints |
|--------|-----------|
| Auth | Staff sign-in / OTP / session (reuses admin auth) |
| Overview / badges | `GET /overview`, `GET /badges` (Mongo counts) |
| Orders | list/detail, step machine, reject, **create on behalf**, negotiation, price-variations, changes, CSV export |
| Customers | list/detail/suspend, CSV export |
| KYC | queue, decide, CSV export |
| Payments | pending list, confirm/reject, CSV export |
| Refunds | list/get/create/patch + review/approve/decline/processing/complete (four-eyes) |
| Payouts | list, create from order, approve (four-eyes), release (Idem + bank ref) |
| Auctions | list/create/transition/finalize/winner-order, CSV export |
| Documents | register list/get/reissue/cancel |
| Catalogue / files | read hierarchy, signed file URLs |
| Me | `GET /me/actions` |

## Money & idempotency

- Amounts are integer **minor units**.
- Financial writes (`bids`, `refunds`, `payout release`, payments) require `Idempotency-Key` where specified.
- Refunds reach `refunded` **only** after `POST …/complete` with a real `bankRef` (no fake success).
- Payouts above `PAYOUT_APPROVER_MINOR` (default 500000) need **two distinct** finance approvers before release.

## Legacy

`/v1` and `/admin/v1` remain mounted and must not be broken by `/v2` work.
