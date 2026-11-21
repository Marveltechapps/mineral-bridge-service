# Testing Report

## Commands

```bash
npm run typecheck
npm run lint
npm test                 # Vitest unit + regression (includes legacy)
npm run test:e2e         # Mongo memory HTTP/service E2E for /v2 modules
```

## Suites

| Suite | What it covers |
|-------|----------------|
| Existing Vitest (~348+) | Auth OTP, auctions bidding, orders idempotency, admin smoke, catalog, realtime, workflow |
| `tests/v2.e2e.http.test.ts` | Auctions finalize+settlement, refund four-eyes+bankRef gate, documents PDF/JSON, order chat, price variation, change requests, payout four-eyes+release, CSV exports, admin badges |

## Mongo

E2E uses **mongodb-memory-server** only (`mb_test`). Never point Vitest at production Mongo.

## External providers

| Integration | Status without live credentials |
|-------------|----------------------------------|
| SMS OTP | Provider wired; sandbox/dev OTP path in non-prod |
| Email OTP | Nodemailer; needs SMTP env |
| BTC rate | Provider module; needs rate API key for live quotes |
| Payment PSP | Confirmations are staff-driven; no fake auto-success |
| File storage | Local/signed URL; S3-compatible when env set |

Live OTP/PSP/BTC cannot be claimed verified without credentials.

## Regression gate

- TypeScript `tsc --noEmit` must pass.
- Legacy `/v1` and `/admin/v1` tests must remain green.
- New modules must not mark refunds/payouts completed without bank/payout reference.
