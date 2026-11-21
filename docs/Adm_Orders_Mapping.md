# adm_orders mapping (13 records)

Date: 2026-11-19. Read-only review. No hosted writes.

## Collections

| Collection | Role | Schema |
| --- | --- | --- |
| `orders` (79) | Legacy customer checkout | `orderId`, `userId`, `totalDue` (major), `quantity`, `unit`, `type` buy/sell |
| `cust_orders` (11) | v2 customer / dashboard orders | `reference`, money minors, `workflow.stepKey` (`buy.v2` / `sell.v2`) |
| `adm_orders` (13) | Admin desk trading projection (`AdmOrder`) | `orderId`, desk `stage` enum (`ORDER_STAGES`), `counterpartyId`, `value` money, route, exceptions |

## Why adm_orders is not copied by the legacy planner

The reversible planner copies **legacy `orders` → `cust_orders` only**.

`adm_orders` is a different product surface:

- Stage names are desk vocabulary (`verification`, settlement stages, etc.), not v2 step keys (`quote`, `contractMb`, `payOk`, `ship`, `done`).
- Identity is `orderId` + `counterpartyId`, not necessarily the same as a v2 `reference` + `userId`.
- The customer↔admin bridge already projects customer orders into admin read-models when those paths are used; blindly inserting 13 desk rows into `cust_orders` would invent workflow state and risk duplicate business records.

## Required mapping before any adm_orders write

For each of the 13 rows, verify all of the following before any insert/update:

1. Matching `cust_orders.reference` or legacy `orders.orderId` (if any).
2. Matching customer (`counterpartyId` ↔ `users` / `userId`).
3. Desk `stage` → v2 `workflow.stepKey` table agreed with operations.
4. Money: desk `value` scale vs v2 minor units.
5. Decision: skip, link-only, or project via the existing bridge — never delete the `adm_orders` source row.

Until that table is verified row-by-row, **do not migrate, overwrite, or delete `adm_orders`**.

## Legacy `orders` path (separate)

- 57 rows with `totalDue` are eligible for `cust_orders` insert after backup + explicit approval.
- 22 rows missing `totalDue` stay skipped (no invented prices).
- Hosted writes remain blocked by `hostedDatabase()` until approval and a non-hosted write target, or an explicit override process owned by the operator.
