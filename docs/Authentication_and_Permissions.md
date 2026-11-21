# Authentication and Permissions

## Customers (`/v2`)

- OTP WhatsApp/SMS/email; decoy on unknown sign-in
- Registration JWT (10 min)
- Access JWT + refresh sessions; web cookie `mb_refresh` (`Path=/v2/auth`)
- Suspended/closed → `403 account/suspended|closed`

## Staff (`/v2/admin`)

- Password + OTP (existing admin auth)
- Cookie session + CSRF
- `requireAction` — 12 keys (`ops`, `trading`, `auction`, `kyc`, `suspend`, `inspection`, `finance`, `logistics`, `catalogue`, `support`, `remind`, `settings`)

## Legacy

`/v1` and `/admin/v1` unchanged.
