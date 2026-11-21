# Order collections backup verification

Generated: 2026-11-19

## Location

`backups/orders-2026-11-19T08-39-23-755Z/`

| File | Documents | Bytes | Parse |
| --- | ---: | ---: | --- |
| `orders.json` | **79** | 164,843 | OK |
| `adm_orders.json` | **13** | 26,045 | OK |
| `cust_orders.json` | **11** | 29,865 | OK |
| `manifest.json` | — | 295 | OK |

Manifest counts match the JSON array lengths. Every document has an identity field (`orderId` / `_id` / `reference`). Arrays re-parse without error → **recoverable**.

## Recoverability (do not run without approval)

These are JSON array dumps from a read-only export. Restore would be along the lines of:

```text
mongoimport --uri <URI> --db mineral_bridge --collection orders --file orders.json --jsonArray
mongoimport --uri <URI> --db mineral_bridge --collection adm_orders --file adm_orders.json --jsonArray
mongoimport --uri <URI> --db mineral_bridge --collection cust_orders --file cust_orders.json --jsonArray
```

Use only if a restore is explicitly approved. Prefer restoring into a temporary database first. This verification did **not** import anything.

## Scope note

The “11 related records” in this backup set are the existing `cust_orders` documents (not a third legacy collection). `adm_orders` (13) are included in the backup and remain **untouched** by the legacy migration planner.
