# Catalog hierarchy mapping

Source: Google Sheet `1ptk_PuNT5UTXP7L_0I5s-C3PY4Px_0_a`, tab gid `1332939829` (SKU). Fetched 2026-10-17 as CSV. MongoDB was not updated.

## Sheet columns

`Mineral ID`, `Sub Category Name`, `Mineral Name`, `Category`, `Product Description`, `Primary Image`, `Price`, `Unit`, `Availability`

There is no `Mineral Type` column and no `Product Form` column. Seven section-header rows have no mineral id (`MINARAL BRIDGE`, `MINARALS`, and the five category titles). 136 data rows were accepted.

## Import mapping

| Hierarchy | Source | Rule |
| --- | --- | --- |
| Category | `Category` | Stored exactly |
| Subcategory | `Sub Category Name` | Stored exactly |
| Mineral type | `Mineral Type` column when that column exists; otherwise `Sub Category Name` | Not parsed out of `Mineral Name` |
| Product form | `Product Form` column when that column exists; otherwise `Mineral Name` | Not shortened or guessed |
| Catalog record | one row per `Mineral ID` | Upserted by `attributes.sourceKey` |
| Image | `Primary Image`, or `Image Name` when that column exists | URL is stored as written |

Repeated imports update the same source key. Rows that leave the sheet are withdrawn, not deleted. Records without `attributes.sourceSheet` are left alone, including stock quantities and order `productId` values.

## Categories and subcategories

136 minerals, 46 subcategories.

- **Critical Mineral** — Lithium, Cobalt, Aluminum, Copper, Zinc, Nickel, Tungsten, Phosphate, Manganese, Graphite, Bauxite, Chromite, Vanadium
- **Gemstone** — Diamond, Jadeite, Emerald, Taaffeite, Grandidierite, Serendibite, Ruby, Musgravite, Red Beryl, Benitoite, Poudretteite, Jeremejevite, Alexandrite, Black Opal, Fire Opal, Tanzanite
- **Industrial Mineral** — Silica Sand, Iron, Limestone, Kyanite, Magnesite, Mica, Quartz & Feldspar, Soapstone (Talc), Sulphur, Vermiculite, Dolomite, Gypsum, Granite
- **Precious Metal** — Gold, Platinum, Silver
- **Energy Mineral** — Lignite

Mineral type equals the subcategory for every current row, because the sheet does not name a separate mineral type.

## Precious Metal product forms

Stored exactly as `Mineral Name`. Not copied from Gold onto Silver or Platinum.

**Gold** (mineral type Gold): Gold Concentrate, Gold Nuggets, Grain Shot, Gold Biscuit, Gold Bullion Bars, Gold Dore Bars, Gold Small Hand Poured Collector Bars, Sponge Gold, Gold Flakes, Gold Dust, Gold Powder.

**Platinum:** Platinum Nugget, Platinum Bar, Platinum Grains.

**Silver:** Raw Silver Ore, Silver Bar, Silver Grain, Silver Crystals, Silver Flakes.

The requested label "Minted Bars" is not in the sheet, so it was not created. The sheet names are longer than the short labels in the request (`Gold Biscuit`, not `Biscuit`; `Gold Dore Bars`, not `Dore Bars`).

## Records that need correction

- **MIN0053 Diamond Bort.** The image URL contains `MIN053`, not `MIN0053`: `.../Gemstone/1.Diamond/MIN053-Diamond+Bort`. The URL is stored as the sheet wrote it and flagged because the mineral id is not in the path. It was not replaced.
- **Quartz & Feldspar.** The subcategory name covers more than one mineral. Its six rows stay under that subcategory. They were not split into Quartz and Feldspar.
- **45 image URLs returned HTTP 403** on a HEAD request (91 of 136 returned an image). The URLs are unchanged. A fresh check is in `reports/catalog-image-check.json`.
- Section headers and the sheet's spelling `MINARAL BRIDGE` / `MINARALS` are skipped, not imported as minerals.

## Not written

This pass did not connect to the hosted database and did not run `npm run catalog:sync` against it.
