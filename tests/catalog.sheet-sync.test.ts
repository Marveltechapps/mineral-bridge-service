import { describe, expect, it, vi } from 'vitest';
import { hierarchyErrors, imageMatchesSource, imageNameFromUrl, repairCatalogImageUrl } from '../src/modules/catalog/hierarchy.js';
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
    expect(parsed.accepted[0]?.imageName).toBe('min0001.png');
    expect(parsed.accepted[0]?.mineralType).toBe('Lithium');
    expect(parsed.accepted[0]?.productForm).toBe('Lithium Spodumene Ore');
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
  });

  it('treats an HTML sign-in page as an access failure and does not return rows', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>Sign in - Google Accounts</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    await expect(fetchCatalogCsv({ sheetId: 'sheet', fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toBeInstanceOf(CatalogAccessError);
  });
});
