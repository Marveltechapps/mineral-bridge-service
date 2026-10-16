export type KycIdTypeId = 'nin' | 'passport' | 'drivers_licence' | 'voters_card';
export type WebIdType = 'national' | 'passport' | 'licence';
export type WebSide = 'front' | 'back' | 'photo_page';

export interface KycIdType {
  id: KycIdTypeId;
  /** Web vocabulary, when the web client can pick this type. */
  webId?: WebIdType;
  name: string;
  shortLabel: string;
  hint: string;
  numberFormat: { pattern: string; mask?: string; example: string };
  requiresBack: boolean;
}

/** Mobile contract #23 — the canonical catalog. Web `/reference/id-types` should be built from this too. */
export const KYC_ID_TYPES: readonly KycIdType[] = [
  {
    id: 'nin',
    webId: 'national',
    name: 'National ID (NIN)',
    shortLabel: 'NIN',
    hint: '11-digit number on your NIMC slip or card.',
    numberFormat: { pattern: '^\\d{11}$', mask: '#### #### ###', example: '2213 4477 901' },
    requiresBack: true,
  },
  {
    id: 'passport',
    webId: 'passport',
    name: 'International Passport',
    shortLabel: 'Passport',
    hint: 'Photo page, must be in date.',
    numberFormat: { pattern: '^[A-Z]\\d{8}$', mask: '@### #####', example: 'A501 88274' },
    requiresBack: false,
  },
  {
    id: 'drivers_licence',
    webId: 'licence',
    name: "Driver's Licence",
    shortLabel: 'Licence',
    hint: 'Front and back, both sides needed.',
    numberFormat: { pattern: '^[A-Z]{3}-\\d{4}-[A-Z]{2}$', example: 'OSU-4471-AB' },
    requiresBack: true,
  },
  {
    id: 'voters_card',
    name: "Voter's Card (PVC)",
    shortLabel: 'PVC',
    hint: 'Permanent voter card with VIN.',
    numberFormat: { pattern: '^[0-9A-Z]{12}$', example: '90F5A2213447' },
    requiresBack: true,
  },
];

export function getIdType(id: string | undefined | null): KycIdType | undefined {
  return id ? KYC_ID_TYPES.find((t) => t.id === id) : undefined;
}

export function idTypeFromWeb(webId: string | undefined | null): KycIdType | undefined {
  return webId ? KYC_ID_TYPES.find((t) => t.webId === webId) : undefined;
}

/** Web `requiredSides` is authoritative and computed server-side (passport ⇒ photo page only). */
export function requiredWebSides(idType: KycIdType | undefined): WebSide[] {
  if (!idType) return [];
  return idType.id === 'passport' ? ['photo_page'] : ['front', 'back'];
}

/** Strips whitespace and upper-cases; returns null when the number does not fit the type's pattern. */
export function normalizeIdNumber(idType: KycIdType, raw: string): string | null {
  const cleaned = raw.replace(/\s+/g, '').toUpperCase();
  return new RegExp(idType.numberFormat.pattern).test(cleaned) ? cleaned : null;
}
