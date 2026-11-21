# Environment configuration

## Core

| Variable | Purpose |
|----------|---------|
| `MONGODB_URI` | Primary Mongo connection |
| `JWT_ACCESS_SECRET` / refresh secrets | Customer tokens |
| `NODE_ENV` | `development` \| `test` \| `production` |

## Finance thresholds

| Variable | Default | Purpose |
|----------|---------|---------|
| `REFUND_APPROVER_MINOR` | `500000` | Amount above which two distinct finance approvals are required |
| `PAYOUT_APPROVER_MINOR` | `500000` | Same for seller payouts |

## Providers (required for live traffic)

| Variable | Purpose |
|----------|---------|
| SMS provider keys (existing OTP module) | Mobile OTP delivery |
| SMTP / `EMAIL_*` | Email OTP and notifications |
| BTC rate API key (existing rate provider) | Live BTC quotes |
| Payment gateway keys (if enabled) | Automated confirmation webhooks |
| Object storage (`S3_*` / local path) | File and PDF blob storage |

Without credentials, code paths remain real (no fake success). Staff confirmation and bank/payout references are still required to complete money movement.
