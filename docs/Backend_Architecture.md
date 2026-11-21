# Backend architecture (as implemented)

## Stack

Node.js 20+, Express (ESM TypeScript), MongoDB + Mongoose, Zod validation, Vitest.

## API mounts

| Mount | Role |
|-------|------|
| `/v1` | Legacy customer (mobile/web) |
| `/admin/v1` | Legacy admin |
| `/v2` | Customer contract (doc 07) |
| `/v2/admin` | Admin contract (doc 07) |

## Domain modules (selected)

`auth`, `kyc`, `catalog`, `cart`, `orders` (v2 workflow, contract, payments, lifecycle, chat, changes, variation, negotiation), `auctions`, `refunds`, `documents`, `notifications` (+ SSE), `outbox`, `support`, `admin/v2` (orders, overview, payouts, export).

## Money & side effects

- Minor-unit money documents
- Idempotency keys on financial writes
- Outbox worker for deferred notify/settlement topics
- Four-eyes on refund approve (threshold) and payout approve/release
- Refunds/payouts complete only with confirmed bank/payout reference

## Realtime

- Customer SSE: `GET /v2/notifications/stream`
- Auction hub (legacy WS + domain publish)
