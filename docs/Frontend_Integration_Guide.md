# Frontend integration guide

## Clients

| App | Base path | Headers / cookies |
|-----|-----------|-------------------|
| Mobile | `/v2` | `X-Client: mobile` + Bearer |
| Web | `/v2` | `X-Client: web` + `mb_refresh` cookie on `/v2/auth` |
| Admin | `/v2/admin` | `X-Client: admin` + staff session cookie + `X-CSRF-Token` |

## Customer happy path

1. Auth OTP → register/sign-in → `GET /v2/me`
2. KYC → `GET/PATCH /v2/kyc` + file upload `POST /v2/files` (`purpose: kyc`)
3. Catalogue → cart → `POST /v2/orders` (`kind: buy` or `sell`)
4. Quotation accept → contract sign → payment submit
5. Inspection / receipt / shipment as workflow advances
6. Notifications: poll `GET /v2/notifications` and/or SSE `GET /v2/notifications/stream`
7. Auctions: `GET /v2/auctions`, bid with `Idempotency-Key`, winner `POST /v2/auctions/{ref}/order`
8. Refunds: `POST /v2/orders/{ref}/refunds` then track `GET /v2/refunds`
9. Documents: `GET /v2/orders/{ref}/documents` then `GET /v2/documents/{number}?format=pdf`
10. Chat: `GET/POST /v2/orders/{ref}/messages`
11. ORD-17/18: changes + price-variation respond when holds/notifications say so

## Admin happy path

1. `POST /v2/admin/auth/sign-in` → OTP verify → cookie + CSRF
2. `GET /v2/admin/overview` / `GET /v2/admin/badges`
3. Advance with `POST /v2/admin/orders/{ref}/steps/{stepKey}` `{ version, data }`
4. Confirm payments via `/v2/admin/payments/{orderRef}/confirm`
5. Refunds: review → approve (two eyes when over threshold) → processing → complete `{ bankRef }`
6. Payouts: create → approve → release with bank reference
7. CSV: `/v2/admin/orders/export`, `/customers/export`, `/payments/export`, `/refunds/export`, `/auctions/export`, `/kyc/export`
