import { describe, expect, it, vi } from 'vitest';
import { hierarchyErrors, httpCatalogImage, imageMatchesSource, imageNameFromUrl, pickCatalogImage, repairCatalogImageUrl } from '../src/modules/catalog/hierarchy.js';
import { CatalogAccessError, classifyCatalogNames, fetchCatalogCsv, parseCatalogCsv, sheetPriceToE4PerGram, slugify } from '../src/modules/catalog/sheet-sync.js';

const CSV = `Category,Subcategory,Mineral Name,Grade,Unit,Price,Image,Status,ID
Precious,Gold,Gold Concentrate,85%+ Au,kg,61200,https://cdn.example/gold.jpg,published,AU-85
Precious,Gold,Gold Doré,90%+ Au,kg,not-a-price,https://cdn.example/dore.jpg,published,AU-90
Base,Copper,Copper Cathode,Grade A,kg,9.1,,draft,CU-A
Industrial,,Graphite,94% C,kg,1.2,notaurl,active,GR
Industrial,Carbon,Flake Graphite,94% C,kg,1.2,,active,GR-2
`;

describe('catalog sheet parser', () => {
  it('normalises category identity and rejects bad rows without inventing minerals', () => {
    const parsed = parseCatalogCsv(CSV);
    expect(parsed.missingHeaders).toEqual([]);
    expect(parsed.accepted.map((r) => r.name)).toEqual(['Gold Concentrate', 'Flake Graphite']);
    expect(parsed.accepted[0]?.categorySlug).toBe(slugify('Precious'));
    expect(parsed.accepted[0]).toMatchObject({
      mineralType: 'Gold',
      productForm: 'Gold Concentrate',
      mineralTypeSource: 'subcategory',
      productFormSource: 'mineral-name',
    });
    expect(parsed.accepted[1]?.imageUrl).toBeNull();
    expect(parsed.rows.find((r) => r.sourceRow === 3)?.status).toBe('invalid');
    expect(parsed.rows.find((r) => r.sourceRow === 4)?.status).toBe('skipped');
    expect(parsed.rows.find((r) => r.sourceRow === 5)?.status).toBe('invalid');
    expect(parsed.rows.find((r) => r.sourceRow === 5)?.errors).toContain('image is not an http(s) URL');
  });

  it('refuses to map rows when the required headers are absent', () => {
    const parsed = parseCatalogCsv('Foo,Bar\n1,2\n');
    expect(parsed.missingHeaders).toEqual(['category', 'name']);
    expect(parsed.accepted).toHaveLength(0);
  });

  it('reads the SKU sheet columns and keeps the quoted price per metric ton', () => {
    const csv = `Mineral ID,Sub Category Name,Mineral Name,Category,Product Description,Primary Image,Price,Unit,Availability
,MINARALS,,,,,,,
MIN0001,Lithium,Lithium Spodumene Ore,Critical Mineral,Battery metal,https://cdn.example/min0001.png,"$1,289 / MT",MT,
`;
    const parsed = parseCatalogCsv(csv);
    expect(parsed.missingHeaders).toEqual([]);
    expect(parsed.rows.find((r) => r.sourceRow === 2)?.status).toBe('skipped');
    expect(parsed.accepted).toHaveLength(1);
    expect(parsed.accepted[0]).toMatchObject({
      name: 'Lithium Spodumene Ore',
      category: 'Critical Mineral',
      subcategory: 'Lithium',
      price: 1289,
      unit: 'MT',
      imageUrl: 'https://cdn.example/min0001.png',
    });
    expect(sheetPriceToE4PerGram(1289, 'MT')).toBe(1289);
    expect(sheetPriceToE4PerGram(74, 'g')).toBe(74_000_000);
    expect(sheetPriceToE4PerGram(4000, 'ct')).toBe(20_000_000_000);
    expect(sheetPriceToE4PerGram(4000, 'carat')).toBe(20_000_000_000);
    expect(parsed.accepted[0]?.imageName).toBe('min0001.png');
    expect(parsed.accepted[0]?.mineralType).toBe('Lithium');
    expect(parsed.accepted[0]?.productForm).toBe('Lithium Spodumene Ore');
  });

  it('reads the workbook SKU tab without quantity or price', () => {
    const csv = `Mineral ID,category & Sub Category Name,Mineral Name,Category,Product Description,Primary Image,Price,Unit,Availability
MCT1,Precious Metal,,,,,,,
MSCT1.1,Gold,,,,,,,
MIN0001,Gold,Gold Concentrate,Precious Metal,Jewellery metal,https://cdn.example/min0001.png,$72 / g,g,
MIN0012,,,,,,,,
`;
    const parsed = parseCatalogCsv(csv);
    expect(parsed.missingHeaders).toEqual([]);
    expect(parsed.accepted).toHaveLength(1);
    expect(parsed.accepted[0]).toMatchObject({
      sourceId: 'MIN0001',
      name: 'Gold Concentrate',
      category: 'Precious Metal',
      subcategory: 'Gold',
      unit: 'g',
      price: 72,
    });
    expect(parsed.rows.filter((r) => r.status === 'skipped').map((r) => r.sourceRow)).toEqual([2, 3, 5]);
    expect(parsed.rows.find((r) => r.sourceRow === 5)?.errors).toContain('no mineral name');
  });

  it('uses Mineral Type and Product Form columns when they exist and does not shorten names', () => {
    const csv = `Category,Subcategory,Mineral Type,Product Form,Mineral Name,Image,ID
Precious Metal,Gold,Gold,Bullion Bars,Gold Bullion Bars,https://cdn.example/MIN0120-Gold+Bullion+Bars.png,MIN0120
`;
    const parsed = parseCatalogCsv(csv);
    expect(parsed.accepted[0]).toMatchObject({
      name: 'Gold Bullion Bars',
      mineralType: 'Gold',
      productForm: 'Bullion Bars',
      mineralTypeSource: 'column',
      productFormSource: 'column',
      imageName: 'MIN0120-Gold+Bullion+Bars.png',
    });
    expect(classifyCatalogNames({
      category: 'Precious Metal',
      subcategory: 'Gold',
      mineralName: 'Gold Bullion Bars',
      mineralTypeColumn: '',
      productFormColumn: '',
    }).productForm).toBe('Gold Bullion Bars');
  });

  it('reads available quantity and unit without converting the number', () => {
    const csv = `Mineral,Category,Unit,Available Quantity,Minimum Quantity,Grade
Gold Concentrate,Precious Metal,kg,250,10,85%+ Au
Packed Ore,Precious Metal,2000g,,1.5,Au
Dust,Precious Metal,25000 Ct,,"",
Volume,Industrial Mineral,litre,2.5,0.5,bulk
Milligrams,Precious Metal,mg,250.5,,fine
`;
    const parsed = parseCatalogCsv(csv);
    expect(parsed.missingHeaders).toEqual([]);
    expect(parsed.accepted.map((r) => ({ name: r.name, unit: r.unit, availableQty: r.availableQty, minQty: r.minQty }))).toEqual([
      { name: 'Gold Concentrate', unit: 'kg', availableQty: 250, minQty: 10 },
      { name: 'Packed Ore', unit: 'g', availableQty: 2000, minQty: 1.5 },
      { name: 'Dust', unit: 'ct', availableQty: 25000, minQty: null },
      { name: 'Volume', unit: 'litre', availableQty: 2.5, minQty: 0.5 },
      { name: 'Milligrams', unit: 'mg', availableQty: 250.5, minQty: null },
    ]);
  });

  it('rejects a product form attached to a different category', () => {
    expect(hierarchyErrors({
      categorySlug: 'gemstone',
      subcategorySlug: 'gemstone-diamond',
      subcategoryCategorySlug: 'gemstone',
      mineralTypeSlug: 'precious-metal-gold',
      mineralTypeCategorySlug: 'precious-metal',
      mineralTypeSubcategorySlug: 'precious-metal-gold',
      productFormCategorySlug: 'precious-metal',
      productFormSubcategorySlug: 'precious-metal-gold',
      productFormMineralTypeSlug: 'precious-metal-gold',
    })).toContain('mineral type does not belong to category');
    expect(imageMatchesSource('https://cdn.example/MIN0116-Gold+Concentrate.png', 'MIN0116')).toBe(true);
    expect(imageMatchesSource('https://cdn.example/other.png', 'MIN0116')).toBe(false);
    expect(imageNameFromUrl('https://cdn.example/a/MIN0116-Gold%20Concentrate.png?w=400')).toBe('MIN0116-Gold Concentrate.png');
    const bare = 'https://cdn.example/website/MIN0120-Gold+Bullion+Bars?w=400&q=60';
    expect(repairCatalogImageUrl(bare)).toBe('https://cdn.example/website/MIN0120-Gold+Bullion+Bars.png?w=400&q=60');
    expect(repairCatalogImageUrl('https://cdn.example/MIN0119-Gold+Biscuit.png?w=400')).toBe('https://cdn.example/MIN0119-Gold+Biscuit.png?w=400');
    expect(repairCatalogImageUrl(null)).toBeNull();
    expect(httpCatalogImage('/assets/m4/cat-precious.png')).toBeNull();
    expect(httpCatalogImage('https://cdn.example/gold.png')).toBe('https://cdn.example/gold.png');
  });

  it('picks each mineral image from that mineral only', () => {
    const gold = pickCatalogImage('Gold', null, null, [
      { name: 'Grain Shot', imageUrl: 'https://cdn.example/grain.png', imageName: 'Grain Shot.png' },
      { name: 'Gold Dust', imageUrl: 'https://cdn.example/gold-dust.png', imageName: 'Gold Dust.png' },
    ]);
    const platinum = pickCatalogImage('Platinum', null, null, [
      { name: 'Platinum Bar', imageUrl: 'https://cdn.example/platinum.png', imageName: 'Platinum Bar.png' },
    ]);
    expect(gold?.url).toBe('https://cdn.example/gold-dust.png');
    expect(platinum?.url).toBe('https://cdn.example/platinum.png');
    expect(gold?.url).not.toBe(platinum?.url);
    expect(pickCatalogImage('Diamond', null, null, [
      { name: 'Diamond Grit', imageUrl: '/assets/m4/cat-gemstone.png', imageName: 'cat-gemstone', isActive: true },
    ])).toBeNull();
    expect(pickCatalogImage('Lithium', 'https://cdn.example/lithium.png', 'Lithium.png', [])).toEqual({
      url: 'https://cdn.example/lithium.png',
      name: 'Lithium.png',
    });
  });

  it('treats an HTML sign-in page as an access failure and does not return rows', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>Sign in - Google Accounts</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    await expect(fetchCatalogCsv({ sheetId: 'sheet', fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toBeInstanceOf(CatalogAccessError);
  });
});
