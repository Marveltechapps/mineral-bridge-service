import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CategoryModel, ProductFormModel, ProductModel } from '../src/models/catalog.model.js';
import { OrderModel } from '../src/models/order.model.js';
import { syncCatalogFromCsv } from '../src/modules/catalog/sheet-sync.js';
import { buildApp, MOBILE, WEB } from './helpers/harness.js';
import { useMemoryMongo } from './setup.js';

useMemoryMongo('catalog_hierarchy');

const CSV = `Mineral ID,Sub Category Name,Mineral Name,Category,Product Description,Primary Image,Price,Unit,Availability
,Critical Mineral,,,,,,,
MIN0001,Lithium,Lithium Spodumene Ore,Critical Mineral,Battery metal,https://cdn.example/Critical/MIN0001-Lithium.png,10,MT,
MIN0053,Diamond,Diamond Bort,Gemstone,Stone,https://cdn.example/Gem/MIN0053-Diamond.png,20,kg,
MIN0071,Silica Sand,Silica Ore,Industrial Mineral,Sand,https://cdn.example/Industrial/MIN0071-Silica.png,30,MT,
MIN0116,Gold,Gold Concentrate,Precious Metal,Metal,https://cdn.example/Gold/MIN0116-Gold+Concentrate.png,40,kg,
MIN0117,Gold,Gold Nuggets,Precious Metal,Metal,https://cdn.example/Gold/MIN0117-Gold+Nuggets.png,41,kg,
MIN0118,Gold,Grain Shot,Precious Metal,Metal,https://cdn.example/Gold/MIN0118-Grain+Shot.png,42,kg,
MIN0119,Gold,Gold Biscuit,Precious Metal,Metal,https://cdn.example/Gold/MIN0119-Gold+Biscuit.png,43,kg,
MIN0120,Gold,Gold Bullion Bars,Precious Metal,Metal,https://cdn.example/Gold/MIN0120-Gold+Bullion+Bars.png,44,kg,
MIN0121,Gold,Gold Dore Bars,Precious Metal,Metal,https://cdn.example/Gold/MIN0121-Gold+Dore+Bars.png,45,kg,
MIN0122,Gold,Gold Small Hand Poured Collector Bars,Precious Metal,Metal,https://cdn.example/Gold/MIN0122-collector.png,46,kg,
MIN0123,Gold,Sponge Gold,Precious Metal,Metal,https://cdn.example/Gold/MIN0123-Sponge+Gold.png,47,kg,
MIN0124,Gold,Gold Flakes,Precious Metal,Metal,https://cdn.example/Gold/MIN0124-Gold+Flakes.png,48,kg,
MIN0125,Gold,Gold Dust,Precious Metal,Metal,https://cdn.example/Gold/MIN0126-wrong.png,49,kg,
MIN0126,Gold,Gold Powder,Precious Metal,Metal,https://cdn.example/Gold/MIN0126-Gold+Powder.png,50,kg,
MIN0127,Platinum,Platinum Bar,Precious Metal,Metal,https://cdn.example/Plat/MIN0127-Platinum+Bar.png,60,kg,
MIN0130,Silver,Silver Bar,Precious Metal,Metal,https://cdn.example/Silver/MIN0130-Silver+Bar.png,15,kg,
MIN0135,Lignite,Lignite ROM,Energy Mineral,Coal,https://cdn.example/Energy/MIN0135-Lignite.png,5,MT,
`;

const fetchImpl = (async () => new Response(null, { status: 200, headers: { 'content-type': 'image/png' } })) as unknown as typeof fetch;

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI as string);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
});

describe('catalog hierarchy import', () => {
  it('imports the five categories, gold forms, and keeps lots and orders on a second run', async () => {
    const manual = await ProductModel.create({
      reference: 'MBV-MANUAL-1',
      name: 'Hand lot',
      typeSlug: 'legacy-type',
      categorySlug: 'legacy',
      mineralCode: 'LEGACY',
      origin: { country: 'KE' },
      availableGrams: 500,
      unitPriceMinorE4PerGram: 1,
    });
    const first = await syncCatalogFromCsv(CSV, 'test-sheet', fetchImpl);
    expect(first.accessError).toBeUndefined();
    expect(first.created).toBe(17);
    expect(first.invalid).toBe(0);
    const categories = await CategoryModel.find({}).sort({ name: 1 }).lean();
    expect(categories.map((c) => c.name).sort()).toEqual([
      'Critical Mineral',
      'Energy Mineral',
      'Gemstone',
      'Industrial Mineral',
      'Precious Metal',
    ]);
    await CategoryModel.create({ slug: 'empty-category', name: 'Empty Category', sort: 99, active: true });
    const goldType = 'precious-metal-gold';
    const forms = await ProductFormModel.find({ mineralTypeSlug: goldType }).sort({ name: 1 }).lean();
    expect(forms.map((f) => f.name)).toEqual([
      'Gold Biscuit',
      'Gold Bullion Bars',
      'Gold Concentrate',
      'Gold Dore Bars',
      'Gold Dust',
      'Gold Flakes',
      'Gold Nuggets',
      'Gold Powder',
      'Gold Small Hand Poured Collector Bars',
      'Grain Shot',
      'Sponge Gold',
    ]);
    expect(forms.find((f) => f.name === 'Gold Concentrate')?.imageUrl).toContain('MIN0116');
    expect(forms.find((f) => f.name === 'Gold Dust')?.imageName).toBe('MIN0126-wrong.png');
    const dust = first.rows.find((r) => r.mapped?.name === 'Gold Dust');
    expect(dust?.errors).toContain('image url does not contain the mineral id');
    const bullion = await ProductModel.findOne({ name: 'Gold Bullion Bars' }).lean();
    expect(bullion?.productFormSlug).toBe(forms.find((f) => f.name === 'Gold Bullion Bars')?.slug);
    const order = await OrderModel.create({
      reference: 'ORD-KEEP-1',
      userId: 'usr_test',
      side: 'buy',
      source: { kind: 'product', refId: bullion!._id },
      lines: [{ productId: bullion!._id, name: 'Gold Bullion Bars', grams: 10, unitPriceMinorE4PerGram: 1, lineTotalMinor: 1 }],
      totalGrams: 10,
      subtotal: { amountMinor: 1, currency: 'USD' },
      platformFee: { amountMinor: 0, currency: 'USD' },
      surcharge: { amountMinor: 0, currency: 'USD' },
      total: { amountMinor: 1, currency: 'USD' },
    });
    bullion!.availableGrams = 2500;
    await ProductModel.updateOne({ _id: bullion!._id }, { $set: { availableGrams: 2500 } });

    const second = await syncCatalogFromCsv(CSV, 'test-sheet', fetchImpl);
    expect(second.created).toBe(0);
    expect(second.unchanged + second.updated).toBe(17);
    const again = await ProductModel.findOne({ name: 'Gold Bullion Bars' }).lean();
    expect(again?._id).toBe(bullion?._id);
    expect(again?.reference).toBe(bullion?.reference);
    expect(again?.availableGrams).toBe(2500);
    const keptOrder = await OrderModel.findById(order._id).lean();
    expect(keptOrder?.lines[0]?.productId).toBe(bullion?._id);
    const keptManual = await ProductModel.findById(manual._id).lean();
    expect(keptManual?.status).not.toBe('withdrawn');
    expect(keptManual?.availableGrams).toBe(500);

    const app = buildApp();
    const tree = await request(app).get('/v1/catalog/hierarchy').set(MOBILE);
    expect(tree.status).toBe(200);
    const names = (tree.body.categories as { name: string; subcategories: unknown[] }[]).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['Precious Metal', 'Gemstone', 'Industrial Mineral', 'Critical Mineral', 'Energy Mineral', 'Empty Category']));
    const empty = (tree.body.categories as { name: string; subcategories: unknown[] }[]).find((c) => c.name === 'Empty Category');
    expect(empty?.subcategories).toEqual([]);
    const precious = (tree.body.categories as { name: string; subcategories: { name: string; mineralTypes: { name: string; productForms: { name: string }[] }[] }[] }[])
      .find((c) => c.name === 'Precious Metal');
    expect(precious?.subcategories.map((s) => s.name).sort()).toEqual(['Gold', 'Platinum', 'Silver']);
    const goldForms = precious?.subcategories.find((s) => s.name === 'Gold')?.mineralTypes[0]?.productForms as { name: string; productId?: string | null }[] | undefined;
    expect(goldForms).toHaveLength(11);
    expect(goldForms?.find((form) => form.name === 'Gold Bullion Bars')?.productId).toBe(bullion?._id);

    const lots = await request(app).get('/v1/lots').query({ category: 'precious-metal', subcategory: 'precious-metal-gold', type: goldType, productForm: bullion!.productFormSlug, q: 'Bullion' }).set(WEB);
    expect(lots.status).toBe(200);
    expect(lots.body.items).toHaveLength(1);
    expect(lots.body.items[0].productFormName).toBe('Gold Bullion Bars');
    expect(lots.body.items[0].imageUrl).toContain('MIN0120');

    const other = await request(app).get('/v1/catalog/types/precious-metal-platinum/forms').set(MOBILE);
    expect(other.body.data.map((f: { name: string }) => f.name)).toEqual(['Platinum Bar']);
    const none = await request(app).get('/v1/lots').query({ q: 'no-such-mineral-zzz' }).set(WEB);
    expect(none.body.items).toEqual([]);
    const crossed = await request(app).get('/v1/lots').query({ category: 'gemstone', productForm: bullion!.productFormSlug }).set(WEB);
    expect(crossed.body.items).toEqual([]);
  });
});
