# Requirements Traceability

| Requirement area | Status |
|------------------|--------|
| 07 Auth / me / KYC / files / catalogue / cart | **Done** (`/v2`) |
| 07 Orders buy/sell workflow + payments + contracts | **Done** |
| 07 ORD-17 changes | **Done** `POST /v2/orders/{ref}/changes` + admin request |
| 07 ORD-18 price variation | **Done** customer respond + admin propose |
| 07 ORD-21 / ORD-22 documents | **Done** issued register + JSON/PDF |
| 07 ORD-24 order chat | **Done** messages on order thread |
| 07 Auctions AUC-01…06 | **Done** `/v2/auctions` wrapping auctions service |
| 07 Refunds RFD-01…03 + ARFD | **Done** + four-eyes approve + bankRef complete |
| 07 Admin overview / badges | **Done** Mongo counts |
| 07 Admin CSV export | **Done** orders/customers/payments/refunds/auctions/kyc/payouts |
| 07 Admin on-behalf order | **Done** `POST /v2/admin/orders` |
| 07 APO payouts + four-eyes | **Done** |
| 07 AORD-10 negotiation | **Done** order negotiation messages |
| 07 Notifications SSE / outbox | **Done** (prior) |
| Legacy `/v1` + `/admin/v1` | **Preserved** |
| Live SMS/email/PSP/BTC without credentials | **Configured, not live-verified** |
