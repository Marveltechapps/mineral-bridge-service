# Workflow Documentation

## buy.v2 (customer + admin)

`accepted` → `quote` → `quoteOk` → `confirmed` → `contract` → `contractMb` → `paid` → `payOk` → `assigned` → `picked` → `transit` → `delivered` → `receipt` → `done`

- Customer creates at `accepted` (no stock reserve)
- Admin `accepted` reserves stock; `quote` issues `Quotation`; customer accept → `confirmed`
- Admin `confirmed` → `contract`; customer signs → `contractMb`; admin countersign → `paid`
- Customer payment → `payOk`; finance confirm → logistics → customer receipt → `done`

## sell.v2

`reviewed` → `quote` → `quoteOk` → `confirmed` → `contract` → `contractMb` → `form` → `formOk` → `schedule` → `inspect` → `sgs` → `reportOk` → `approved` → `payout` → `ship` → `delivered` → `done`

Admin advances via `POST /v2/admin/orders/{ref}/steps/{stepKey}`.
