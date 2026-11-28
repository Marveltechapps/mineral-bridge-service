/**
 * Master-sheet quantities are stored as the number and unit the sheet wrote.
 * A cell such as "2000g" or "20MT" is a quantity plus a unit, not a unit name.
 * Mass is also copied to integer grams when that conversion does not change the number.
 */

export interface SheetQuantity {
  availableQty: number | null;
  unit: string;
  quantityFromSheet: boolean;
  unitFromSheet: boolean;
}

const UNIT_LABELS: Record<string, string> = {
  g: 'g',
  gram: 'g',
  grams: 'g',
  kg: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  mg: 'mg',
  milligram: 'mg',
  milligrams: 'mg',
  t: 't',
  tonne: 'tonne',
  tonnes: 'tonne',
  ton: 'tonne',
  tons: 'tonne',
  mt: 'MT',
  'metric ton': 'MT',
  'metric tonne': 'MT',
  l: 'litre',
  litre: 'litre',
  liter: 'litre',
  liters: 'litre',
  litres: 'litre',
  ml: 'ml',
  millilitre: 'ml',
  milliliter: 'ml',
  millilitres: 'ml',
  milliliters: 'ml',
  ct: 'ct',
  carat: 'ct',
  carats: 'ct',
  oz: 'oz',
  ounce: 'oz',
  ounces: 'oz',
};

export function canonicalSheetUnit(raw: string): string {
  const key = raw.trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
  if (!key) return '';
  return UNIT_LABELS[key] ?? raw.trim();
}

export function parseSheetNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed || !/\d/.test(trimmed)) return null;
  const n = Number(trimmed.replace(/,/g, '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** "2000g", "20MT", "25000 Ct" → quantity and unit. A bare unit such as "kg" is not a quantity. */
export function splitCombinedUnit(raw: string): { qty: number; unit: string } | null {
  const match = /^(\d+(?:\.\d+)?)\s*([A-Za-z]+)$/.exec(raw.trim().replace(/,/g, ''));
  if (!match) return null;
  const qty = Number(match[1]);
  if (!Number.isFinite(qty) || qty < 0) return null;
  return { qty, unit: canonicalSheetUnit(match[2] || '') };
}

export function readSheetQuantity(quantityRaw: string, unitRaw: string): SheetQuantity {
  const unitText = unitRaw.trim();
  const explicit = parseSheetNumber(quantityRaw);
  const combined = unitText ? splitCombinedUnit(unitText) : null;
  if (explicit != null && combined) {
    return { availableQty: explicit, unit: combined.unit, quantityFromSheet: true, unitFromSheet: true };
  }
  if (explicit != null) {
    return {
      availableQty: explicit,
      unit: unitText ? canonicalSheetUnit(unitText) : 'kg',
      quantityFromSheet: true,
      unitFromSheet: Boolean(unitText),
    };
  }
  if (combined) {
    return { availableQty: combined.qty, unit: combined.unit, quantityFromSheet: true, unitFromSheet: true };
  }
  if (unitText) {
    return { availableQty: null, unit: canonicalSheetUnit(unitText), quantityFromSheet: false, unitFromSheet: true };
  }
  return { availableQty: null, unit: 'kg', quantityFromSheet: false, unitFromSheet: false };
}

/** Integer grams when the conversion is exact. Volume units and fractional grams stay unset. */
export function sheetQuantityToGrams(qty: number, unit: string): number | null {
  if (!Number.isFinite(qty) || qty < 0) return null;
  const label = canonicalSheetUnit(unit);
  let grams: number | null = null;
  if (label === 'g') grams = qty;
  else if (label === 'kg') grams = qty * 1000;
  else if (label === 'mg') grams = qty / 1000;
  else if (label === 't' || label === 'tonne' || label === 'MT') grams = qty * 1_000_000;
  else if (label === 'ct') grams = qty * 0.2;
  else if (label === 'oz') grams = qty * 31.1034768;
  else return null;
  const rounded = Math.round(grams);
  if (!Number.isSafeInteger(rounded) || Math.abs(grams - rounded) > 1e-4) return null;
  return rounded;
}

export function gramsToSheetQty(grams: number, unit: string): number {
  const label = canonicalSheetUnit(unit);
  let value = grams;
  if (label === 'kg') value = grams / 1000;
  else if (label === 't' || label === 'tonne' || label === 'MT') value = grams / 1_000_000;
  else if (label === 'mg') value = grams * 1000;
  else if (label === 'ct') value = grams / 0.2;
  else if (label === 'oz') value = grams / 31.1034768;
  return Math.round(value * 1e6) / 1e6;
}

export function sheetUnitIsMass(unit: string): boolean {
  return sheetQuantityToGrams(1, unit) != null;
}
