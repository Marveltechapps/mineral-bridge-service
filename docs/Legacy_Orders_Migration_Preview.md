# Legacy orders migration preview (no write)

Generated: 2026-11-19T09:27:45.591Z

## Counts

| Item | Count |
| --- | ---: |
| Legacy `orders` scanned | 79 |
| Eligible for insert into `cust_orders` | 57 |
| Skipped | 22 |
| Existing `cust_orders` | 11 |
| `adm_orders` (untouched) | 13 |

## Skip reasons

- missing totalDue: 22

## Eligible records (57)

| orderId | side | totalDue (major) | amountMinor | grams | unit | target step | status |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
| MB-ORDER-41123 | sell | 6000 | 600000 | 24000000 | MT | reviewed | active |
| MB-ORDER-28527 | sell | 4320 | 432000 | 5 | ct | reviewed | active |
| MB-ORDER-51904 | buy | 2083.75 | 208375 | 25000000 | MT | accepted | active |
| MB-ORDER-39107 | buy | 1209.696 | 120970 | 10 | g | done | completed |
| MB-ORDER-29037 | buy | 3725 | 372500 | 25000000 | MT | accepted | active |
| MB-ORDER-44523 | buy | 247311.75 | 24731175 | 25000000 | MT | accepted | active |
| MB-ORDER-55729 | buy | 1927.2 | 192720 | 10 | g | done | completed |
| MB-ORDER-49370 | buy | 1927.2 | 192720 | 10 | g | accepted | active |
| MB-ORDER-65689 | buy | 1927.2 | 192720 | 10 | g | done | completed |
| MB-ORDER-46736 | sell | 3250 | 325000 | 25000000 | MT | done | completed |
| MB-ORDER-73888 | sell | 475 | 47500 | 25000000 | MT | reviewed | active |
| MB-ORDER-52372 | sell | 451800 | 45180000 | 5 | ct | done | completed |
| MB-ORDER-52402 | sell | 5000 | 500000 | 25000000 | MT | done | completed |
| MB-ORDER-55468 | sell | 23.5 | 2350 | 25 | g | done | completed |
| MB-ORDER-91224 | buy | 2184.75 | 218475 | 25 | g | done | completed |
| MB-ORDER-57132 | sell | 813250 | 81325000 | 25000000 | MT | done | completed |
| MB-ORDER-66343 | sell | 19875 | 1987500 | 25000000 | MT | done | completed |
| MB-ORDER-63223 | sell | 125000 | 12500000 | 5 | ct | done | completed |
| MB-ORDER-85838 | sell | 23.5 | 2350 | 25 | g | done | completed |
| MB-ORDER-85321 | buy | 2083.75 | 208375 | 25000000 | MT | done | completed |
| MB-ORDER-43255 | sell | 950 | 95000 | 50000000 | MT | done | completed |
| MB-ORDER-24621 | buy | 127450 | 12745000 | 5 | ct | done | completed |
| MB-ORDER-99678 | buy | 1223.9875 | 122399 | 25 | g | accepted | active |
| MB-ORDER-92483 | buy | 11300 | 1130000 | 25000000 | MT | accepted | cancelled |
| MB-ORDER-83751 | buy | 102200 | 10220000 | 5 | ct | accepted | active |
| MB-ORDER-75881 | buy | 3725 | 372500 | 25000000 | MT | accepted | active |
| MB-ORDER-13871 | buy | 1679.75 | 167975 | 25000000 | MT | done | completed |
| MB-ORDER-81607 | buy | 9103.25 | 910325 | 25000000 | MT | done | completed |
| MB-ORDER-39609 | buy | 8775 | 877500 | 25000000 | MT | done | completed |
| MB-ORDER-22469 | sell | 960 | 96000 | 24 | g | reviewed | active |
| MB-ORDER-86705 | sell | 960 | 96000 | 24000000 | MT | reviewed | active |
| MB-ORDER-81576 | sell | 480 | 48000 | 24000000 | MT | done | completed |
| MB-ORDER-52132 | sell | 288000 | 28800000 | 5 | ct | done | completed |
| MB-ORDER-42348 | sell | 16776 | 1677600 | 24000000 | MT | done | completed |
| MB-ORDER-25199 | sell | 264000 | 26400000 | 5 | ct | done | completed |
| MB-ORDER-23887 | buy | 127450 | 12745000 | 5 | ct | done | completed |
| MB-ORDER-37550 | sell | 475 | 47500 | 25000000 | MT | reviewed | active |
| MB-ORDER-94186 | sell | 500000 | 50000000 | 5 | ct | reviewed | active |
| MB-ORDER-33056 | buy | 1927.2 | 192720 | 10 | g | accepted | active |
| MB-ORDER-29280 | sell | 200000 | 20000000 | 2 | ct | reviewed | active |
| MB-ORDER-67256 | sell | 720 | 72000 | 10 | g | reviewed | active |
| MB-ORDER-84469 | buy | 1276.76 | 127676 | 1 | g | accepted | active |
| MB-ORDER-88880 | sell | 72 | 7200 | 1 | g | reviewed | active |
| MB-ORDER-72393 | sell | 180720 | 18072000 | 2 | ct | reviewed | active |
| MB-ORDER-98061 | sell | 72 | 7200 | 1 | g | reviewed | active |
| MB-ORDER-94525 | buy | 1927.2 | 192720 | 10 | g | accepted | active |
| MB-ORDER-34497 | buy | 1937.3 | 193730 | 10 | g | accepted | active |
| MB-ORDER-57822 | buy | 1977.7 | 197770 | 10 | g | accepted | active |
| MB-ORDER-41728 | buy | 1947.4 | 194740 | 10 | g | accepted | active |
| MB-ORDER-17747 | buy | 1927.2 | 192720 | 10 | g | accepted | active |
| MB-ORDER-28976 | buy | 1927.2 | 192720 | 10 | g | accepted | active |
| MB-ORDER-72397 | buy | 1250 | 125000 | 1 | g | accepted | active |
| MB-ORDER-19996 | buy | 1075 | 107500 | 1 | g | accepted | active |
| MB-ORDER-70802 | buy | 3119 | 311900 | 25 | g | accepted | active |
| MB-ORDER-88451 | buy | 1224.24 | 122424 | 25 | g | accepted | active |
| MB-ORDER-49965 | sell | 1440 | 144000 | 20 | g | reviewed | active |
| MB-ORDER-92684 | buy | 1927.2 | 192720 | 10 | g | accepted | active |

Full JSON (includes userId, legacyId, mineralName): `docs/Legacy_Orders_Migration_Preview.json`

**No migration was executed.**