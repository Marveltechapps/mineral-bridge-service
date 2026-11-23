/**
 * Default records shared by the startup initializer and `npm run seed`.
 * These are the same rows the manual seed script used to insert.
 * Callers insert a row only when its key is missing.
 */

export const ROLE_KIND: Record<string, string> = {
  'ROLE-CEO': 'executive',
  'ROLE-DESK': 'desk',
  'ROLE-COMPLIANCE': 'compliance',
  'ROLE-SUPPORT': 'support',
  'ROLE-CONTENT': 'content',
  'ROLE-CLERK': 'data_entry',
};

/** Console role key stored on the Role document. ROLE-CLERK has no console key. */
export const ROLE_CONSOLE_KEY: Record<string, string> = {
  'ROLE-CEO': 'super',
  'ROLE-DESK': 'ops',
  'ROLE-COMPLIANCE': 'compliance',
  'ROLE-SUPPORT': 'support',
  'ROLE-CONTENT': 'catalogue',
};

export const CATEGORIES = [
  ['CAT-PRECIOUS', 'Precious metals'],
  ['CAT-BASE', 'Base metals'],
  ['CAT-BATTERY', 'Battery & critical minerals'],
  ['CAT-GEMS', 'Gemstones'],
  ['CAT-INDUSTRIAL', 'Industrial minerals'],
] as const;

export const MINERALS: Array<[string, string, string, string[]]> = [
  ['MIN-AU', 'Gold Concentrate', 'CAT-PRECIOUS', ['85%+ Au', '70-85% Au', '<70% Au']],
  ['MIN-AUD', 'Gold Doré', 'CAT-PRECIOUS', ['90%+ Au', '75-90% Au']],
  ['MIN-AG', 'Silver Concentrate', 'CAT-PRECIOUS', ['>90% Ag']],
  ['MIN-CU', 'Copper Cathode', 'CAT-BASE', ['Grade A (99.99%)']],
  ['MIN-SN', 'Tin Concentrate', 'CAT-BASE', ['65% Sn']],
  ['MIN-CO', 'Cobalt Hydroxide', 'CAT-BATTERY', ['30% Co']],
  ['MIN-LI', 'Lithium Spodumene', 'CAT-BATTERY', ['6% Li2O']],
  ['MIN-TA', 'Coltan (Tantalite)', 'CAT-BATTERY', ['30% Ta2O5']],
  ['MIN-W', 'Wolframite', 'CAT-BASE', ['65% WO3']],
  ['MIN-EM', 'Emerald (rough)', 'CAT-GEMS', ['AAA', 'AA', 'A']],
  ['MIN-TZ', 'Tanzanite (rough)', 'CAT-GEMS', ['AAA', 'AA']],
  ['MIN-GR', 'Graphite', 'CAT-INDUSTRIAL', ['94% C']],
];

export const UNITS = [
  ['g', 'Gram', 1],
  ['kg', 'Kilogram', 1000],
  ['t', 'Tonne', 1_000_000],
  ['oz', 'Troy ounce', 31.1034768],
] as const;

/** [code, name, dialCode, currency, btc regulation, label, rail, enabled] */
export const COUNTRIES: Array<[string, string, string, string, string, string, string, boolean]> = [
  ['KE', 'Kenya', '+254', 'KES', 'permitted_limited', 'VASP Act 2025 — licence required', 'on_chain', true],
  ['NG', 'Nigeria', '+234', 'NGN', 'permitted_limited', 'SEC digital-asset rules', 'on_chain', false],
  ['GH', 'Ghana', '+233', 'GHS', 'restricted', 'Bank of Ghana — pending framework', 'none', false],
  ['TZ', 'Tanzania', '+255', 'TZS', 'restricted', 'No clear regime', 'none', false],
  ['UG', 'Uganda', '+256', 'UGX', 'restricted', 'Central bank warning in force', 'none', false],
  ['ZA', 'South Africa', '+27', 'ZAR', 'permitted_vasp', 'FSCA-licensed CASPs', 'lightning_and_onchain', true],
  ['ZM', 'Zambia', '+260', 'ZMW', 'restricted', 'Under review', 'none', false],
  ['CD', 'DR Congo', '+243', 'CDF', 'prohibited', 'Not recognised', 'none', false],
  ['RW', 'Rwanda', '+250', 'RWF', 'restricted', 'Under review', 'none', false],
  ['AE', 'United Arab Emirates', '+971', 'AED', 'permitted_vasp', 'VARA-licensed VASPs', 'lightning_and_onchain', true],
  ['CH', 'Switzerland', '+41', 'CHF', 'permitted_vasp', 'FINMA-regulated', 'lightning_and_onchain', true],
  ['GB', 'United Kingdom', '+44', 'GBP', 'permitted_vasp', 'FCA-registered', 'on_chain', true],
  ['US', 'United States', '+1', 'USD', 'permitted_limited', 'State-by-state MSB rules', 'on_chain', false],
];

export const BANKS: Array<[string, string, string, string]> = [
  ['BNK-KCB', 'KCB Bank Kenya', 'KE', 'KCBLKENX'],
  ['BNK-EQT', 'Equity Bank Kenya', 'KE', 'EQBLKENA'],
  ['BNK-STD', 'Standard Chartered', 'GB', 'SCBLGB2L'],
  ['BNK-ENBD', 'Emirates NBD', 'AE', 'EBILAEAD'],
  ['BNK-UBS', 'UBS Switzerland', 'CH', 'UBSWCHZH'],
];

/** [id, mineral, grade, feed buy, feed sell] — USD per kg. Sample desk rates for an empty local database. */
export const RATES: Array<[string, string, string, number, number]> = [
  ['RATE-AU-85', 'Gold Concentrate', '85%+ Au', 61_200, 63_900],
  ['RATE-AU-70', 'Gold Concentrate', '70-85% Au', 51_400, 53_700],
  ['RATE-AUD-90', 'Gold Doré', '90%+ Au', 69_800, 72_100],
  ['RATE-AG', 'Silver Concentrate', '>90% Ag', 780, 835],
  ['RATE-CU', 'Copper Cathode', 'Grade A (99.99%)', 9.1, 9.7],
  ['RATE-SN', 'Tin Concentrate', '65% Sn', 27.4, 29.8],
  ['RATE-CO', 'Cobalt Hydroxide', '30% Co', 14.9, 16.2],
  ['RATE-TA', 'Coltan (Tantalite)', '30% Ta2O5', 86, 94],
];

export const SAMPLE_RATE_IDS = RATES.map((row) => row[0]);

export const ACADEMY_CATEGORIES: Array<[string, string]> = [
  ['CAT-GS', 'Getting Started'],
  ['CAT-SELL', 'Selling Minerals'],
  ['CAT-BUY', 'Buying & Auctions'],
  ['CAT-KYC', 'Compliance & KYC'],
  ['CAT-LOG', 'Logistics & Vault'],
  ['CAT-TF', 'Trade Finance'],
];

export const SAMPLE_COURSE_ID = 'CRS-0001';

export interface CatalogueLot {
  categorySlug: string;
  categoryName: string;
  categoryImage: string;
  subcategorySlug: string;
  subcategoryName: string;
  typeSlug: string;
  typeName: string;
  mineralCode: string;
  formSlug: string;
  formName: string;
  reference: string;
  name: string;
  grade: string;
  purity: string;
  country: string;
  region: string;
  site: string;
  grams: number;
  minGrams: number;
  /** USD per kilogram. */
  usdPerKg: number;
  imageName: string;
  description: string;
}

/** Marketplace lots the web and mobile catalogues read from `/v2/catalogue`. Local development only. */
export const CATALOGUE: CatalogueLot[] = ([
  ['precious-metals', 'Precious metals', 'cat-precious', 'gold', 'Gold', 'gold-dore', 'Gold Doré', 'AU', 'dore-bar', 'Doré bar', 'MBV-AU-DORE-01', 'Ashanti gold doré bar', '90%+ Au', '92.4% Au', 'GH', 'Ashanti', 'Obuasi', 12_400, 100, 69_800, 'gold-dore', 'Poured doré from a licensed Ghanaian producer. Weight and fineness checked at the vault.'],
  ['precious-metals', 'Precious metals', 'cat-precious', 'gold', 'Gold', 'gold-concentrate', 'Gold Concentrate', 'AU', 'gold-concentrate', 'Concentrate', 'MBV-AU-CONC-01', 'Geita gold concentrate', '85%+ Au', '86.1% Au', 'TZ', 'Geita', 'Geita', 250_000, 1_000, 63_900, 'gold-concentrate', 'Gravity concentrate, bagged and sealed. Assay report available with the lot.'],
  ['precious-metals', 'Precious metals', 'cat-precious', 'gold', 'Gold', 'gold-bullion', 'Gold Bullion', 'AU', 'bullion', 'Bullion', 'MBV-AU-BULL-01', 'Rand gold bullion', '99.5% Au', '99.5% Au', 'ZA', 'Gauteng', 'Johannesburg', 8_000, 100, 72_100, 'gold-bullion', 'Small-bar bullion held in a bonded vault. Suitable for refinery and investor buyers.'],
  ['precious-metals', 'Precious metals', 'cat-precious', 'silver', 'Silver', 'silver-concentrate', 'Silver Concentrate', 'AG', 'silver-concentrate', 'Concentrate', 'MBV-AG-CONC-01', 'Taxco silver concentrate', '>90% Ag', '91.2% Ag', 'MX', 'Guerrero', 'Taxco', 400_000, 5_000, 835, 'm-silver', 'Flotation concentrate from a registered mill. Moisture and penalty elements disclosed.'],
  ['base-metals', 'Base metals', 'cat-industrial', 'copper', 'Copper', 'copper-cathode', 'Copper Cathode', 'CU', 'cathode', 'Cathode', 'MBV-CU-CATH-01', 'Copperbelt cathode', 'Grade A (99.99%)', '99.99% Cu', 'ZM', 'Copperbelt', 'Kitwe', 5_000_000, 25_000, 9.7, 'cat-industrial', 'LME-grade cathode, strapped bundles. Ready for export from the bonded yard.'],
  ['base-metals', 'Base metals', 'cat-industrial', 'tin', 'Tin', 'tin-concentrate', 'Tin Concentrate', 'SN', 'tin-concentrate', 'Concentrate', 'MBV-SN-CONC-01', 'Jos tin concentrate', '65% Sn', '67% Sn', 'NG', 'Plateau', 'Jos', 80_000, 1_000, 29.8, 'cat-industrial', 'Alluvial tin concentrate, dried and bagged. Export permit on file.'],
  ['battery-minerals', 'Battery & critical minerals', 'cat-critical', 'cobalt', 'Cobalt', 'cobalt-hydroxide', 'Cobalt Hydroxide', 'CO', 'hydroxide', 'Hydroxide', 'MBV-CO-HYD-01', 'Kolwezi cobalt hydroxide', '30% Co', '32% Co', 'CD', 'Lualaba', 'Kolwezi', 1_200_000, 10_000, 16.2, 'cat-critical', 'Crude hydroxide from a traceable cooperative. Moisture and payability stated on the assay.'],
  ['battery-minerals', 'Battery & critical minerals', 'cat-critical', 'lithium', 'Lithium', 'lithium-spodumene', 'Lithium Spodumene', 'LI', 'spodumene', 'Spodumene', 'MBV-LI-SPO-01', 'Bikita spodumene', '6% Li2O', '6.1% Li2O', 'ZW', 'Masvingo', 'Bikita', 8_000_000, 50_000, 1.15, 'cat-critical', 'SC6 spodumene concentrate in bulk bags. Sampling certificate attached to the lot.'],
  ['battery-minerals', 'Battery & critical minerals', 'cat-critical', 'coltan', 'Coltan', 'coltan-tantalite', 'Coltan (Tantalite)', 'TA', 'tantalite', 'Tantalite', 'MBV-TA-COL-01', 'Kigali tantalite', '30% Ta2O5', '31% Ta2O5', 'RW', 'Kigali', 'Kigali', 180_000, 1_000, 94, 'cat-critical', 'Hand-sorted tantalite. Chain-of-custody documents travel with the shipment.'],
  ['gemstones', 'Gemstones', 'cat-gemstone', 'emerald', 'Emerald', 'emerald-rough', 'Emerald (rough)', 'EM', 'emerald-rough', 'Rough', 'MBV-EM-RGH-01', 'Kagem rough emerald', 'AA', 'AA', 'ZM', 'Copperbelt', 'Kagem', 1_500, 50, 420_000, 'cat-gemstone', 'Rough emerald parcel, individually weighed. Not a treated stone.'],
  ['gemstones', 'Gemstones', 'cat-gemstone', 'tanzanite', 'Tanzanite', 'tanzanite-rough', 'Tanzanite (rough)', 'TZ', 'tanzanite-rough', 'Rough', 'MBV-TZ-RGH-01', 'Merelani tanzanite', 'AA', 'AA', 'TZ', 'Manyara', 'Merelani', 800, 20, 610_000, 'cat-gemstone', 'Rough tanzanite from the Merelani block. Parcel weight is the sellable quantity.'],
  ['industrial-minerals', 'Industrial minerals', 'cat-industrial', 'graphite', 'Graphite', 'graphite-flake', 'Graphite', 'GR', 'flake', 'Flake', 'MBV-GR-FLK-01', 'Balama flake graphite', '94% C', '94.6% C', 'MZ', 'Cabo Delgado', 'Balama', 12_000_000, 100_000, 0.85, 'cat-industrial', 'Natural flake graphite, jumbo and large flake. Packed for industrial offtake.'],
] as const).map((row): CatalogueLot => {
  const [categorySlug, categoryName, categoryImage, subcategorySlug, subcategoryName, typeSlug, typeName, mineralCode, formSlug, formName, reference, name, grade, purity, country, region, site, grams, minGrams, usdPerKg, imageName, description] = row;
  return { categorySlug, categoryName, categoryImage, subcategorySlug, subcategoryName, typeSlug, typeName, mineralCode, formSlug, formName, reference, name, grade, purity, country, region, site, grams, minGrams, usdPerKg, imageName, description };
});

export const SAMPLE_PRODUCT_REFERENCES = CATALOGUE.map((lot) => lot.reference);
