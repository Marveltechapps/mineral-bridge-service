import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consoleStage, customerRole, kycWord, moneyMajor } from '../src/modules/admin/v2/admin-console.service.js';
import { startMemoryReplSet, stopMemoryReplSet } from './setup.js';

const PASSWORD = 'Correct-Horse-9!Battery';
const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD', scale: 2 });
/** A 1x1 transparent PNG. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('console mappers', () => {
  it('converts money, workflow steps, roles and KYC words', () => {
    expect(moneyMajor({ amountMinor: 125050, scale: 2 })).toBe(1250.5);
    expect(moneyMajor(null)).toBe(0);
    expect(consoleStage('buy', 'quote', 'active')).toEqual({ stage: 2, serverStep: 'quote' });
    expect(consoleStage('sell', 'ship', 'active')).toEqual({ stage: 15, serverStep: 'ship' });
    expect(consoleStage('buy', 'done', 'completed').stage).toBe(15);
    expect(customerRole(['buyer', 'seller'])).toBe('both');
    expect(customerRole(['seller'])).toBe('seller');
    expect(kycWord('verified')).toBe('approved');
    expect(kycWord('resubmission_required')).toBe('requested');
    expect(kycWord('in_review')).toBe('pending');
  });
});

describe('dashboard integration against the database', () => {
  let app: Express;
  let storageRoot = '';

  beforeAll(async () => {
    await startMemoryReplSet('mb_dashboard_it');
    // Uploaded lot media goes to a throwaway folder, never the repo's ./uploads.
    storageRoot = mkdtempSync(path.join(os.tmpdir(), 'mb-dashboard-it-'));
    process.env.STORAGE_LOCAL_ROOT = storageRoot;
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    const { resetEnvCache } = await import('../src/config/env.js');
    resetEnvCache();
    const { connectDatabase } = await import('../src/config/database.js');
    await connectDatabase();
    const { createApp } = await import('../src/app.js');
    app = createApp();
    const { createStaff } = await import('../src/modules/staff/staff.service.js');
    await createStaff({ email: 'ceo@mineralbridge.co.ke', password: PASSWORD, name: 'Platform CEO', roleId: 'ROLE-CEO' });
    await createStaff({ email: 'support@mineralbridge.co.ke', password: PASSWORD, name: 'Support Agent', roleId: 'ROLE-SUPPORT' });
  }, 120_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await stopMemoryReplSet();
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
  });

  async function signIn(email: string) {
    const agent = request.agent(app);
    const res = await agent.post('/v2/admin/auth/sign-in').set('X-Client', 'admin').send({ email, password: PASSWORD });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const cookies = res.headers['set-cookie'];
    const joined = (Array.isArray(cookies) ? cookies : cookies ? [cookies] : []).join('\n');
    expect(joined).toMatch(/Path=\/v2\/admin/i);
    const csrf = String(res.headers['x-csrf-token'] || res.body.me?.csrfToken || '');
    expect(csrf.length).toBeGreaterThan(8);
    const call = (method: 'get' | 'post' | 'patch' | 'delete', url: string) => {
      const req = agent[method](url).set('X-Client', 'admin').set('X-CSRF-Token', csrf);
      return req;
    };
    return { agent, csrf, call };
  }

  it('rejects anonymous console access and enforces action permissions', async () => {
    const missingClient = await request(app).get('/v2/admin/console');
    expect(missingClient.status).toBe(400);
    expect(missingClient.body.code).toBe('request/client-required');

    const anon = await request(app).get('/v2/admin/console').set('X-Client', 'admin');
    expect(anon.status).toBe(401);

    const support = await signIn('support@mineralbridge.co.ke');
    const denied = await support.call('get', '/v2/admin/payments');
    expect(denied.status).toBe(403);

    const noCsrf = await support.agent.post('/v2/admin/customers').set('X-Client', 'admin').send({ fullName: 'No Token' });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.code).toBe('auth/csrf');
  });

  it('creates, reads, updates and deletes through the admin API and the console snapshot', async () => {
    const ceo = await signIn('ceo@mineralbridge.co.ke');
    const { UserModel } = await import('../src/modules/users/user.model.js');
    const { ProductModel } = await import('../src/models/catalog.model.js');
    const { OrderModel } = await import('../src/models/order.model.js');

    const buyer = await UserModel.create({
      customerNo: 'C-9001',
      email: 'buyer.integration@example.com',
      phone: '+254711900001',
      roles: ['buyer'],
      kycStatus: 'verified',
      accountStatus: 'active',
      profile: { fullName: 'Halden Buyer', companyName: 'Halden Refining', countryCode: 'CH' },
      business: { name: 'Halden Refining', buyerType: 'refinery' },
    });
    const lot = await ProductModel.create({
      reference: 'LOT-INT-1',
      name: 'Integration Gold Bar',
      typeSlug: 'gold',
      categorySlug: 'precious',
      mineralCode: 'AU',
      origin: { country: 'NG', display: 'Lagos · Nigeria' },
      status: 'active',
      availableGrams: 2500,
      minOrderGrams: 100,
      unitPriceMinorE4PerGram: 1,
      qty: { measure: 'mass', unit: 'kg', base: 2_500_000 },
      seller: { name: 'Mineral Bridge', tier: 'mineral_bridge', verified: true },
      attributes: {},
    });
    await OrderModel.create({
      reference: 'MB-ORD-INT-1',
      userId: String(buyer._id),
      customerNo: 'C-9001',
      side: 'buy',
      status: 'active',
      source: { kind: 'admin' },
      workflow: { definition: 'buy.v2', stepKey: 'quote', stepIndex: 1, phase: 1, owner: 'platform', role: 'trading', enteredAt: new Date() },
      lines: [{ name: 'Integration Gold Bar', productId: String(lot._id), grams: 2500, unitPriceMinorE4PerGram: 1, lineTotalMinor: 10000, qty: { measure: 'mass', unit: 'kg', base: 2_500_000 } }],
      totalGrams: 2500,
      subtotal: usd(10000),
      platformFee: usd(0),
      surcharge: usd(0),
      total: usd(10000),
      version: 3,
    });
    await OrderModel.create({
      reference: 'MB-ORD-INT-2',
      userId: String(buyer._id),
      customerNo: 'C-9001',
      side: 'sell',
      status: 'active',
      source: { kind: 'sell_request' },
      workflow: { definition: 'sell.v2', stepKey: 'reviewed', stepIndex: 0, phase: 0, owner: 'platform', role: 'ops', enteredAt: new Date() },
      lines: [],
      sell: { mineralSlug: 'gold', name: 'Doré', qty: { measure: 'mass', unit: 'kg', base: 1800 }, grade: 'Au 90', form: 'Doré bar', details: 'Integration sell request for the dashboard.' },
      totalGrams: 1800,
      subtotal: usd(0),
      platformFee: usd(0),
      surcharge: usd(0),
      total: usd(0),
      version: 1,
    });

    const snap = await ceo.call('get', '/v2/admin/console');
    expect(snap.status).toBe(200);
    expect(snap.body.live).toBe(true);
    expect(snap.body.meta.source).toBe('database');
    expect(snap.body.orders.map((o: { id: string }) => o.id)).toEqual(expect.arrayContaining(['MB-ORD-INT-1', 'MB-ORD-INT-2']));
    const buy = snap.body.orders.find((o: { id: string }) => o.id === 'MB-ORD-INT-1');
    expect(buy).toMatchObject({ kind: 'buy', serverStep: 'quote', stage: 2, version: 3, live: true, cust: 'C-9001' });
    expect(buy.total).toBe(100);
    expect(snap.body.customers.find((c: { id: string }) => c.id === 'C-9001')).toMatchObject({
      name: 'Halden Buyer', role: 'buyer', kyc: 'approved', status: 'active',
    });
    expect(snap.body.lots.find((l: { id: string }) => l.id === 'LOT-INT-1')).toMatchObject({ name: 'Integration Gold Bar', status: 'listed' });

    const page = await ceo.call('get', '/v2/admin/orders?kind=buy&q=INT-1&page=1&pageSize=1');
    expect(page.status).toBe(200);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.items[0].ref).toBe('MB-ORD-INT-1');
    expect(page.body.page).toBe(1);

    const search = await ceo.call('get', '/v2/admin/search?q=Halden');
    expect(search.status).toBe(200);
    expect(search.body.customers.some((c: { name?: string }) => c.name === 'Halden Buyer')).toBe(true);

    const created = await ceo.call('post', '/v2/admin/customers').send({
      fullName: 'New Integration Customer',
      email: 'new.customer@example.com',
      countryCode: 'NG',
      businessName: 'Integration Mining',
      role: 'seller',
    });
    expect(created.status).toBe(201);
    expect(created.body.customerNo).toMatch(/^C-/);
    const renamed = await ceo.call('patch', `/v2/admin/customers/${created.body.id}`).send({ fullName: 'Renamed Customer', countryCode: 'KE' });
    expect(renamed.status).toBe(200);
    const suspended = await ceo.call('post', `/v2/admin/customers/${created.body.id}/suspend`).send({ reason: 'Integration test suspension' });
    expect(suspended.status).toBe(200);
    const afterSuspend = await UserModel.findById(created.body.id).lean();
    expect(afterSuspend?.accountStatus).toBe('suspended');
    const back = await ceo.call('post', `/v2/admin/customers/${created.body.id}/reinstate`);
    expect(back.status).toBe(200);
    expect((await UserModel.findById(created.body.id).lean())?.accountStatus).toBe('active');

    const draft = await ceo.call('post', '/v2/admin/catalogue/lots').send({
      name: 'Draft Coltan', mineral: 'tantalum', unit: 'kg', avail: 4, origin: 'Rubaya · DR Congo', grade: 'Ta 28%',
    });
    expect(draft.status).toBe(201);
    const listed = await ceo.call('patch', `/v2/admin/catalogue/lots/${draft.body.reference}`).send({ status: 'listed', grade: 'Ta 30%' });
    expect(listed.status).toBe(200);
    expect(listed.body.status).toBe('active');
    const blockedDelete = await ceo.call('delete', `/v2/admin/catalogue/lots/${draft.body.reference}`);
    expect(blockedDelete.status).toBe(409);
    await ceo.call('patch', `/v2/admin/catalogue/lots/${draft.body.reference}`).send({ status: 'draft' });
    const removed = await ceo.call('delete', `/v2/admin/catalogue/lots/${draft.body.reference}`);
    expect(removed.status).toBe(204);
    expect(await ProductModel.countDocuments({ reference: draft.body.reference })).toBe(0);

    const opens = new Date(Date.now() + 3600_000).toISOString();
    const closes = new Date(Date.now() + 86_400_000).toISOString();
    const auction = await ceo.call('post', '/v2/admin/auctions').send({
      name: 'Integration auction', quantityGrams: 1000, startingBidMinor: 500000, stepMinor: 10000, opensAt: opens, closesAt: closes,
    });
    expect(auction.status).toBe(201);
    const seen = await ceo.call('get', '/v2/admin/console');
    expect(seen.body.auctions.some((a: { auctionId?: string; id?: string }) => a.auctionId === auction.body._id || a.id === auction.body.reference)).toBe(true);
    const deletedAuction = await ceo.call('delete', `/v2/admin/auctions/${auction.body.reference}`);
    expect(deletedAuction.status).toBe(204);

    const saved = await ceo.call('patch', '/v2/admin/settings').send({ fee: 2.5, bidStep: 250 });
    expect(saved.status).toBe(200);
    const again = await ceo.call('get', '/v2/admin/console');
    expect(again.body.settings.fee).toBe(2.5);
    expect(again.body.settings.bidStep).toBe(250);

    const overview = await ceo.call('get', '/v2/admin/overview');
    expect(overview.status).toBe(200);
    expect(overview.body.kpis).toBeTruthy();
    const badges = await ceo.call('get', '/v2/admin/badges');
    expect(badges.status).toBe(200);
    expect(typeof badges.body.pendingOrders).toBe('number');
  });

  it('supports the live-mode actions: staff-raised orders, holds, lot pricing, auctions, support and notifications', async () => {
    const ceo = await signIn('ceo@mineralbridge.co.ke');
    const { UserModel } = await import('../src/modules/users/user.model.js');
    const { ProductModel } = await import('../src/models/catalog.model.js');
    const { OrderModel } = await import('../src/models/order.model.js');
    const { AuctionModel } = await import('../src/models/auction.model.js');
    const { SupportTicketModel } = await import('../src/models/support.model.js');
    const { NotificationModel } = await import('../src/models/notification.model.js');

    const customer = await UserModel.create({
      customerNo: 'C-9002',
      email: 'live.actions@example.com',
      phone: '+254711900002',
      roles: ['buyer', 'seller'],
      kycStatus: 'verified',
      accountStatus: 'active',
      profile: { fullName: 'Live Actions', companyName: 'Live Actions Ltd', countryCode: 'KE' },
      business: { name: 'Live Actions Ltd', buyerType: 'refinery' },
    });
    const customerId = String(customer._id);
    await ProductModel.create({
      reference: 'LOT-LIVE-1',
      name: 'Live Action Copper',
      typeSlug: 'copper',
      categorySlug: 'base',
      mineralCode: 'CU',
      origin: { country: 'ZM', display: 'Ndola · Zambia' },
      status: 'active',
      availableGrams: 50_000,
      minOrderGrams: 100,
      unitPriceMinorE4PerGram: 50_000,
      qty: { measure: 'mass', unit: 'kg', base: 50_000 },
      seller: { name: 'Mineral Bridge', tier: 'mineral_bridge', verified: true },
      attributes: {},
    });

    // Staff-raised buy order carries the optional note onto the timeline.
    const buy = await ceo.call('post', '/v2/admin/orders').send({
      customerId,
      kind: 'buy',
      items: [{ productRef: 'LOT-LIVE-1', qty: { value: 1, unit: 'kg' } }],
      delivery: { org: 'Live Actions Ltd', street: '1 Test Road', city: 'Nairobi', country: 'KE', contact: 'Live Actions', mobile: '+254711900002' },
      note: 'Raised by phone',
    });
    expect(buy.status, JSON.stringify(buy.body)).toBe(201);
    const buyDoc = await OrderModel.findOne({ reference: buy.body.reference }).lean();
    expect(buyDoc?.source?.kind).toBe('admin');
    expect(buyDoc?.timeline?.some((t) => t.stepKey === 'created' && t.note === 'Raised by phone')).toBe(true);

    // Staff-raised sell request accepts attested photos instead of uploaded files.
    const sell = await ceo.call('post', '/v2/admin/orders').send({
      customerId,
      kind: 'sell',
      sell: { mineral: 'gold', qty: { value: 5, unit: 'kg' }, grade: 'Au 90', form: 'Doré bar', details: 'Walk-in sell request raised by staff.', photosReceived: 3 },
    });
    expect(sell.status, JSON.stringify(sell.body)).toBe(201);
    const fewPhotos = await ceo.call('post', '/v2/admin/orders').send({
      customerId,
      kind: 'sell',
      sell: { mineral: 'gold', qty: { value: 5, unit: 'kg' }, grade: 'Au 90', form: 'Doré bar', details: 'Walk-in sell request raised by staff.', photosReceived: 2 },
    });
    expect(fewPhotos.status).toBe(422);

    // Hold then clear with a reason; the clear lands on the timeline.
    const held = await ceo.call('post', `/v2/admin/orders/${buy.body.reference}/hold`).send({ type: 'clarify', reason: 'Need the assay certificate' });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    const cleared = await ceo.call('post', `/v2/admin/orders/${buy.body.reference}/hold`).send({ clear: true, reason: 'Assay received' });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    const afterHold = await OrderModel.findOne({ reference: buy.body.reference }).lean();
    expect(afterHold?.timeline?.some((t) => t.label === 'Hold cleared' && t.note === 'Assay received')).toBe(true);

    // Lot minimum order and reference price round-trip through PATCH and the snapshot.
    const patched = await ceo.call('patch', '/v2/admin/catalogue/lots/LOT-LIVE-1').send({ minOrder: 2, referencePrice: 12.5 });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const lotDoc = await ProductModel.findOne({ reference: 'LOT-LIVE-1' }).lean();
    expect(lotDoc?.minOrderGrams).toBe(2000);
    expect(lotDoc?.unitPriceMinorE4PerGram).toBe(12_500);

    // Auction cancel stores the reason and the transition is idempotent for the dashboard flow.
    const opens = new Date(Date.now() + 3600_000).toISOString();
    const closes = new Date(Date.now() + 86_400_000).toISOString();
    const auction = await ceo.call('post', '/v2/admin/auctions').send({
      name: 'Cancel me', quantityGrams: 1000, startingBidMinor: 500000, stepMinor: 10000, opensAt: opens, closesAt: closes,
    });
    expect(auction.status).toBe(201);
    const cancelled = await ceo.call('post', `/v2/admin/auctions/${auction.body._id}/transition`).send({ to: 'cancelled', reason: 'Seller withdrew the lot' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    const cancelledDoc = await AuctionModel.findOne({ reference: auction.body.reference }).lean();
    expect(cancelledDoc?.status).toBe('cancelled');
    expect((cancelledDoc as { cancelReason?: string } | null)?.cancelReason).toBe('Seller withdrew the lot');

    // Staff-created support ticket and manual notification.
    const ticket = await ceo.call('post', '/v2/admin/support').send({ customerId, topic: 'Payment', subject: 'Follow-up', body: 'We are checking your payment.', relatedRef: buy.body.reference });
    expect(ticket.status, JSON.stringify(ticket.body)).toBe(201);
    expect(ticket.body.reference).toBeTruthy();
    const ticketDoc = await SupportTicketModel.findOne({ reference: ticket.body.reference }).lean();
    expect(ticketDoc?.userId).toBe(customerId);
    expect(ticketDoc?.messages?.[0]?.body).toBe('We are checking your payment.');

    const noBody = await ceo.call('post', '/v2/admin/support').send({ customerId, body: '' });
    expect(noBody.status).toBe(422);

    const sent = await ceo.call('post', '/v2/admin/notifications').send({ customerId, message: 'Your documents are ready.', channel: 'email', ref: buy.body.reference });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const notif = await NotificationModel.findById(sent.body.id).lean();
    expect(notif?.userId).toBe(customerId);
    expect(notif?.channels).toContain('email');

    const supportOnly = await signIn('support@mineralbridge.co.ke');
    const allowed = await supportOnly.call('post', '/v2/admin/notifications').send({ customerId, message: 'Hello from support.', channel: 'email' });
    expect(allowed.status).toBe(201);
    const denied = await supportOnly.call('post', '/v2/admin/refunds').send({});
    expect(denied.status).toBe(403);
  });

  it('writes the catalogue hierarchy: categories, subcategories, hide and guarded delete', async () => {
    const ceo = await signIn('ceo@mineralbridge.co.ke');
    const { ProductModel } = await import('../src/models/catalog.model.js');

    const made = await ceo.call('post', '/v2/admin/catalogue/categories').send({ name: 'Gemstones IT', subcategories: ['Emerald IT', 'Sapphire IT'] });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const catSlug = made.body.slug as string;
    expect(made.body.minerals).toHaveLength(2);
    expect((await ceo.call('post', '/v2/admin/catalogue/categories').send({ name: 'gemstones it' })).status).toBe(409);
    expect((await ceo.call('post', '/v2/admin/catalogue/categories').send({ name: 'x' })).status).toBe(422);

    let snap = await ceo.call('get', '/v2/admin/console');
    const cat = snap.body.cats.find((c: { id: string }) => c.id === catSlug);
    expect(cat).toMatchObject({ label: 'Gemstones IT', active: true });
    expect(cat.subs.map((s: { label: string }) => s.label).sort()).toEqual(['Emerald IT', 'Sapphire IT']);
    const emerald = cat.subs.find((s: { label: string }) => s.label === 'Emerald IT') as { id: string };

    const added = await ceo.call('post', '/v2/admin/catalogue/minerals').send({ categorySlug: catSlug, name: 'Ruby IT' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const renamed = await ceo.call('patch', `/v2/admin/catalogue/minerals/${added.body.slug}`).send({ name: 'Ruby Red IT' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Ruby Red IT');
    const off = await ceo.call('patch', `/v2/admin/catalogue/minerals/${added.body.slug}`).send({ active: false });
    expect(off.body.active).toBe(false);
    expect((await ceo.call('delete', `/v2/admin/catalogue/minerals/${added.body.slug}`)).status).toBe(200);

    // A lot filed under the new subcategory takes its place in the hierarchy.
    const lot = await ceo.call('post', '/v2/admin/catalogue/lots').send({ name: 'Emerald parcel', mineral: emerald.id, unit: 'kg', avail: 2, origin: 'Muzo · Colombia' });
    expect(lot.status, JSON.stringify(lot.body)).toBe(201);
    expect((await ProductModel.findOne({ reference: lot.body.reference }).lean())?.categorySlug).toBe(catSlug);

    const blockedMineral = await ceo.call('delete', `/v2/admin/catalogue/minerals/${emerald.id}`);
    expect(blockedMineral.status).toBe(409);
    expect(blockedMineral.body.code).toBe('mineral/has-lots');
    const blockedCategory = await ceo.call('delete', `/v2/admin/catalogue/categories/${catSlug}`);
    expect(blockedCategory.status).toBe(409);
    expect(blockedCategory.body.code).toBe('category/has-lots');

    // Hiding is the way to take a populated category out of the apps.
    const hidden = await ceo.call('patch', `/v2/admin/catalogue/categories/${catSlug}`).send({ active: false, name: 'Gemstones IT Hidden' });
    expect(hidden.status).toBe(200);
    snap = await ceo.call('get', '/v2/admin/console');
    expect(snap.body.cats.find((c: { id: string }) => c.id === catSlug)).toMatchObject({ label: 'Gemstones IT Hidden', active: false });
    const tree = await ceo.call('get', '/v2/admin/catalogue/tree');
    expect(tree.body.items.find((c: { slug: string }) => c.slug === catSlug).lots).toBe(1);

    // Empty it, then it can be deleted with its leftovers.
    await ceo.call('delete', `/v2/admin/catalogue/lots/${lot.body.reference}`).send();
    await ProductModel.deleteOne({ reference: lot.body.reference });
    const goneCategory = await ceo.call('delete', `/v2/admin/catalogue/categories/${catSlug}`);
    expect(goneCategory.status, JSON.stringify(goneCategory.body)).toBe(200);
    snap = await ceo.call('get', '/v2/admin/console');
    expect(snap.body.cats.some((c: { id: string }) => c.id === catSlug)).toBe(false);

    const support = await signIn('support@mineralbridge.co.ke');
    expect((await support.call('post', '/v2/admin/catalogue/categories').send({ name: 'Nope Category' })).status).toBe(403);
    expect((await ceo.call('delete', '/v2/admin/catalogue/categories/missing-one')).status).toBe(404);
  });

  it('attaches, lists, reorders and removes lot images and documents', async () => {
    const ceo = await signIn('ceo@mineralbridge.co.ke');
    const { ProductModel } = await import('../src/models/catalog.model.js');
    const { FileModel } = await import('../src/models/file.model.js');
    const lot = await ceo.call('post', '/v2/admin/catalogue/lots').send({ name: 'Media lot', mineral: 'tin', unit: 'kg', avail: 3, origin: 'Jos · Nigeria' });
    expect(lot.status).toBe(201);
    const ref = lot.body.reference as string;
    const base = `/v2/admin/catalogue/lots/${ref}/media`;

    const bad = await ceo.call('post', base).send({ filename: 'x.txt', contentType: 'text/plain', contentBase64: Buffer.from('hello world').toString('base64') });
    expect(bad.status).toBe(422);

    const one = await ceo.call('post', base).send({ filename: 'front.png', contentType: 'image/png', contentBase64: PNG_BASE64, caption: 'Front' });
    expect(one.status, JSON.stringify(one.body)).toBe(201);
    const two = await ceo.call('post', base).send({ filename: 'back.png', contentType: 'image/png', contentBase64: PNG_BASE64 });
    expect(two.status).toBe(201);
    expect(two.body.images).toHaveLength(2);
    const fileId = one.body.image.fileId as string;

    // The image is served publicly (no console session, no X-Client) so the apps can show it.
    const served = await request(app).get(`/storage/lot-media/${fileId}`);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toMatch(/image\/png/);
    const stored = await ProductModel.findOne({ reference: ref }).lean();
    expect(stored?.imageUrl).toBe(one.body.image.url);

    const cover = await ceo.call('patch', `${base}/${two.body.image.id}`).send({ cover: true, caption: 'Cover shot' });
    expect(cover.status, JSON.stringify(cover.body)).toBe(200);
    expect(cover.body.images[0].id).toBe(two.body.image.id);
    expect((await ProductModel.findOne({ reference: ref }).lean())?.imageUrl).toBe(two.body.image.url);

    const doc = await ceo.call('post', base).send({
      kind: 'document', filename: 'assay.pdf', contentType: 'application/pdf', contentBase64: Buffer.from('%PDF-1.4 test').toString('base64'), type: 'Test report',
    });
    expect(doc.status, JSON.stringify(doc.body)).toBe(201);
    expect(doc.body.document).toMatchObject({ name: 'assay.pdf', ver: 1, visible: true });
    const hiddenDoc = await ceo.call('patch', `${base}/${doc.body.document.id}`).send({ visible: false });
    expect(hiddenDoc.status).toBe(200);
    expect(hiddenDoc.body.document.visible).toBe(false);
    const download = await ceo.call('get', `${base}/${doc.body.document.id}/download`);
    expect(download.status).toBe(200);
    expect(Buffer.from(download.body.contentBase64, 'base64').toString()).toContain('%PDF');

    const listed = await ceo.call('get', base);
    expect(listed.body.images).toHaveLength(2);
    expect(listed.body.documents).toHaveLength(1);
    const snap = await ceo.call('get', '/v2/admin/console');
    const row = snap.body.lots.find((l: { id: string }) => l.id === ref);
    expect(row.media).toHaveLength(2);
    expect(row.ldocs).toHaveLength(1);
    expect(row.images).toBe(2);

    const removed = await ceo.call('delete', `${base}/${one.body.image.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body.images).toHaveLength(1);
    expect((await FileModel.findById(fileId).lean())?.deletedAt).toBeTruthy();
    expect((await request(app).get(`/storage/lot-media/${fileId}`)).status).toBe(404);
    expect((await ceo.call('delete', `${base}/med_missing`)).status).toBe(404);
    const removedDoc = await ceo.call('delete', `${base}/${doc.body.document.id}`);
    expect(removedDoc.body.documents).toHaveLength(0);

    const support = await signIn('support@mineralbridge.co.ke');
    expect((await support.call('post', base).send({ filename: 'a.png', contentType: 'image/png', contentBase64: PNG_BASE64 })).status).toBe(403);
    expect((await ceo.call('get', '/v2/admin/catalogue/lots/NOPE-1/media')).status).toBe(404);
  });

  it('adjusts lot stock with an audit note and compare-and-set safety', async () => {
    const ceo = await signIn('ceo@mineralbridge.co.ke');
    const { ProductModel } = await import('../src/models/catalog.model.js');
    const lot = await ceo.call('post', '/v2/admin/catalogue/lots').send({ name: 'Stock lot', mineral: 'tin', unit: 'kg', avail: 2, origin: 'Jos · Nigeria' });
    const ref = lot.body.reference as string;
    await ceo.call('patch', `/v2/admin/catalogue/lots/${ref}`).send({ status: 'listed' });
    const url = `/v2/admin/catalogue/lots/${ref}/stock`;

    const add = await ceo.call('post', url).send({ deltaGrams: 500, reason: 'Received a new parcel' });
    expect(add.status, JSON.stringify(add.body)).toBe(200);
    expect(add.body).toMatchObject({ availableGrams: 2500, previousGrams: 2000, deltaGrams: 500 });

    expect((await ceo.call('post', url).send({ deltaGrams: -9000, reason: 'Too much removed' })).status).toBe(409);
    expect((await ceo.call('post', url).send({ deltaGrams: 10 })).status).toBe(422);
    expect((await ceo.call('post', url).send({ deltaGrams: 10, avail: 4, reason: 'Both fields' })).status).toBe(422);
    expect((await ceo.call('post', url).send({ deltaGrams: 0, reason: 'No change at all' })).status).toBe(422);

    const counted = await ceo.call('patch', url).send({ avail: 1.2, unit: 'kg', reason: 'Physical count' });
    expect(counted.status, JSON.stringify(counted.body)).toBe(200);
    expect(counted.body.availableGrams).toBe(1200);
    expect((await ProductModel.findOne({ reference: ref }).lean())?.availableGrams).toBe(1200);

    const out = await ceo.call('post', url).send({ deltaGrams: -1200, reason: 'Shipped everything' });
    expect(out.status).toBe(200);
    expect(out.body.status).toBe('sold');
    const back = await ceo.call('post', url).send({ deltaGrams: 300, reason: 'Recount found stock' });
    expect(back.body.status).toBe('active');

    const snap = await ceo.call('get', '/v2/admin/console');
    const moves = snap.body.moves.filter((m: { lot: string }) => m.lot === ref);
    expect(moves.length).toBe(4);
    expect(moves.some((m: { note: string; delta: number }) => m.note === 'Received a new parcel' && m.delta === 0.5)).toBe(true);
    expect(snap.body.lots.find((l: { id: string }) => l.id === ref).avail).toBe(0.3);

    const audit = await ceo.call('get', '/v2/admin/console');
    expect(audit.body.audit.length).toBeGreaterThan(0);

    const support = await signIn('support@mineralbridge.co.ke');
    expect((await support.call('post', url).send({ deltaGrams: 5, reason: 'Not allowed' })).status).toBe(403);
    expect((await ceo.call('post', '/v2/admin/catalogue/lots/NOPE-1/stock').send({ deltaGrams: 5, reason: 'Missing lot' })).status).toBe(404);
  });

  it('persists custom roles and manages the admin lifecycle', async () => {
    const ceo = await signIn('ceo@mineralbridge.co.ke');
    const { createStaff } = await import('../src/modules/staff/staff.service.js');
    const { StaffModel } = await import('../src/modules/staff/staff.model.js');
    await createStaff({ email: 'desk.life@mineralbridge.co.ke', password: PASSWORD, name: 'Desk Life', roleId: 'ROLE-SUPPORT' });

    // Roles: built-ins are listed, custom roles persist with their permissions.
    const roles = await ceo.call('get', '/v2/admin/roles');
    expect(roles.status).toBe(200);
    expect(roles.body.items.map((r: { key: string }) => r.key)).toEqual(expect.arrayContaining(['super', 'ops', 'support', 'catalogue']));
    const role = await ceo.call('post', '/v2/admin/roles').send({ label: 'Lot reviewer IT', actions: ['catalogue', 'support'] });
    expect(role.status, JSON.stringify(role.body)).toBe(201);
    const roleKey = role.body.key as string;
    expect((await ceo.call('post', '/v2/admin/roles').send({ label: 'lot reviewer it', actions: [] })).status).toBe(409);
    expect((await ceo.call('post', '/v2/admin/roles').send({ label: 'Bad perms IT', actions: ['teleport'] })).status).toBe(422);

    let snap = await ceo.call('get', '/v2/admin/console');
    expect(snap.body.customRoles).toEqual(expect.arrayContaining([[roleKey, 'Lot reviewer IT']]));
    expect(snap.body.perms[roleKey]).toEqual(['catalogue', 'support']);
    expect(snap.body.perms.super).toBeUndefined();
    const desk = snap.body.admins.find((a: { email: string }) => a.email === 'desk.life@mineralbridge.co.ke') as { id: string; role: string };
    expect(desk.role).toBe('support');

    // Moving the admin onto the custom role changes what they can do, immediately.
    const moved = await ceo.call('patch', `/v2/admin/admins/${desk.id}`).send({ name: 'Desk Life Renamed', roleKey });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({ name: 'Desk Life Renamed', role: roleKey });
    const deskSession = await signIn('desk.life@mineralbridge.co.ke');
    const mine = await deskSession.call('get', '/v2/admin/me/actions');
    expect(mine.body).toMatchObject({ roleKey, actions: ['catalogue', 'support'] });
    expect((await deskSession.call('get', '/v2/admin/catalogue/tree')).status).toBe(200);
    expect((await deskSession.call('get', '/v2/admin/payments')).status).toBe(403);
    expect((await deskSession.call('post', '/v2/admin/customers').send({ fullName: 'Blocked Person' })).status).toBe(403);

    // Editing the role's permissions reaches everyone on it.
    const edited = await ceo.call('patch', `/v2/admin/roles/${roleKey}`).send({ actions: ['support'], label: 'Lot reviewer IT 2' });
    expect(edited.status).toBe(200);
    expect(edited.body.actions).toEqual(['support']);
    expect((await deskSession.call('get', '/v2/admin/catalogue/tree')).status).toBe(403);
    expect((await ceo.call('delete', `/v2/admin/roles/${roleKey}`)).status).toBe(409);
    expect((await ceo.call('patch', '/v2/admin/roles/super').send({ actions: [] })).status).toBe(409);
    expect((await ceo.call('delete', '/v2/admin/roles/ops')).status).toBe(409);
    expect((await ceo.call('patch', '/v2/admin/roles/support').send({ actions: ['support', 'kyc'] })).status).toBe(200);
    expect((await ceo.call('patch', '/v2/admin/roles/support').send({ reset: true })).status).toBe(200);

    // Invite straight into a custom role.
    const invited = await ceo.call('post', '/v2/admin/admins/invite').send({ name: 'Custom Invitee', email: 'custom.invitee@mineralbridge.co.ke', roleKey });
    expect(invited.status, JSON.stringify(invited.body)).toBe(201);
    expect((await ceo.call('post', '/v2/admin/admins/invite').send({ name: 'Nobody Role', email: 'nobody.role@mineralbridge.co.ke', roleKey: 'r_missing_0000' })).status).toBe(422);

    // Disable, enable, delete. A disabled admin cannot sign in.
    const off = await ceo.call('post', `/v2/admin/admins/${desk.id}/disable`).send({ reason: 'On leave' });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body.status).toBe('disabled');
    const refused = await request(app).post('/v2/admin/auth/sign-in').set('X-Client', 'admin').send({ email: 'desk.life@mineralbridge.co.ke', password: PASSWORD });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    const on = await ceo.call('post', `/v2/admin/admins/${desk.id}/enable`).send({});
    expect(on.body.status).toBe('active');

    // The CEO cannot disable or delete themselves; the last super admin is protected.
    snap = await ceo.call('get', '/v2/admin/console');
    const self = snap.body.admins.find((a: { email: string }) => a.email === 'ceo@mineralbridge.co.ke') as { id: string };
    const selfDelete = await ceo.call('delete', `/v2/admin/admins/${self.id}`);
    expect(selfDelete.status).toBe(409);
    expect(selfDelete.body.code).toBe('admin/self');
    expect((await ceo.call('post', `/v2/admin/admins/${self.id}/disable`).send({})).status).toBe(409);
    expect((await ceo.call('patch', `/v2/admin/admins/${self.id}`).send({ roleKey: 'ops' })).status).toBe(409);

    const removed = await ceo.call('delete', `/v2/admin/admins/${desk.id}`).send({ reason: 'Left the company' });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    snap = await ceo.call('get', '/v2/admin/console');
    expect(snap.body.admins.some((a: { id: string }) => a.id === desk.id)).toBe(false);
    const kept = await StaffModel.findOne({ publicId: desk.id }).lean();
    expect(kept?.disabled).toBe(true);
    expect(kept?.deletedAt).toBeTruthy();
    expect((await ceo.call('delete', `/v2/admin/admins/${desk.id}`)).status).toBe(404);

    // Someone who can manage admins but is not a super admin still cannot remove the last super admin.
    const managerRole = await ceo.call('post', '/v2/admin/roles').send({ label: 'Admin manager IT', actions: ['settings'] });
    expect(managerRole.status).toBe(201);
    const manager = await createStaff({ email: 'manager.life@mineralbridge.co.ke', password: PASSWORD, name: 'Manager Life', roleId: 'ROLE-SUPPORT' });
    expect((await ceo.call('patch', `/v2/admin/admins/${manager.publicId}`).send({ roleKey: managerRole.body.key })).status).toBe(200);
    const mgr = await signIn('manager.life@mineralbridge.co.ke');
    const dropLast = await mgr.call('delete', `/v2/admin/admins/${self.id}`).send({ reason: 'Trying to remove the last CEO' });
    expect(dropLast.status).toBe(409);
    expect(dropLast.body.code).toBe('admin/last-super');
    expect((await mgr.call('post', `/v2/admin/admins/${self.id}/disable`).send({})).status).toBe(409);
    expect((await mgr.call('patch', `/v2/admin/admins/${self.id}`).send({ roleKey: 'ops' })).status).toBe(409);

    // With a second super admin around, a super admin can be disabled and removed.
    const other = await createStaff({ email: 'ceo2@mineralbridge.co.ke', password: PASSWORD, name: 'Second CEO', roleId: 'ROLE-CEO' });
    expect((await ceo.call('post', `/v2/admin/admins/${other.publicId}/disable`).send({})).status).toBe(200);
    expect((await ceo.call('post', `/v2/admin/admins/${other.publicId}/enable`).send({})).status).toBe(200);
    expect((await ceo.call('delete', `/v2/admin/admins/${other.publicId}`).send({ reason: 'Not needed any more' })).status).toBe(200);

    expect((await signIn('support@mineralbridge.co.ke').then((s) => s.call('patch', `/v2/admin/admins/${manager.publicId}`).send({ name: 'Hacked Name' }))).status).toBe(403);
  });

  it('soft-deletes orders: cancelled with a reason, stock restored, guarded by payment and payout', async () => {
    const ceo = await signIn('ceo@mineralbridge.co.ke');
    const { UserModel } = await import('../src/modules/users/user.model.js');
    const { ProductModel } = await import('../src/models/catalog.model.js');
    const { OrderModel } = await import('../src/models/order.model.js');
    const { PaymentModel, SellerPayoutModel, QuotationModel } = await import('../src/models/workflow.model.js');
    const { AuditLog } = await import('../src/modules/audit/audit.model.js');

    const buyer = await UserModel.create({
      customerNo: 'C-9003',
      email: 'order.delete@example.com',
      phone: '+254711900003',
      roles: ['buyer'],
      kycStatus: 'verified',
      accountStatus: 'active',
      profile: { fullName: 'Order Delete', companyName: 'Delete Ltd', countryCode: 'KE' },
      business: { name: 'Delete Ltd', buyerType: 'refinery' },
    });
    const lot = await ProductModel.create({
      reference: 'LOT-DEL-1',
      name: 'Delete Copper',
      typeSlug: 'copper',
      categorySlug: 'base',
      mineralCode: 'CU',
      origin: { country: 'ZM', display: 'Ndola · Zambia' },
      status: 'active',
      availableGrams: 4000,
      minOrderGrams: 100,
      unitPriceMinorE4PerGram: 1,
      qty: { measure: 'mass', unit: 'kg', base: 4000 },
      seller: { name: 'Mineral Bridge', tier: 'mineral_bridge', verified: true },
      attributes: {},
    });
    const makeOrder = (reference: string, over: Record<string, unknown> = {}) =>
      OrderModel.create({
        reference,
        userId: String(buyer._id),
        customerNo: 'C-9003',
        side: 'buy',
        status: 'active',
        source: { kind: 'admin' },
        workflow: { definition: 'buy.v2', stepKey: 'quote', stepIndex: 2, phase: 1, owner: 'platform', role: 'trading', enteredAt: new Date() },
        lines: [{ name: 'Delete Copper', productId: String(lot._id), grams: 1000, unitPriceMinorE4PerGram: 1, lineTotalMinor: 100, qty: { measure: 'mass', unit: 'kg', base: 1000 } }],
        totalGrams: 1000,
        subtotal: usd(100),
        platformFee: usd(0),
        surcharge: usd(0),
        total: usd(100),
        version: 1,
        ...over,
      });

    // Past "accepted" the stock is reserved; deleting the order puts it back.
    await makeOrder('MB-ORD-DEL-1');
    await ProductModel.updateOne({ _id: lot._id }, { $inc: { availableGrams: -1000 } });
    await QuotationModel.create({
      orderId: (await OrderModel.findOne({ reference: 'MB-ORD-DEL-1' }).lean())!._id,
      number: 'Q-DEL-1', rev: 1, lines: [], product: usd(100), fee: usd(0), transport: usd(0), total: usd(100),
      validUntil: new Date(Date.now() + 86_400_000), status: 'issued', issuedBy: { kind: 'staff', id: 'x', name: 'x' }, issuedAt: new Date(),
    });
    expect((await ceo.call('delete', '/v2/admin/orders/MB-ORD-DEL-1').send({})).status).toBe(422);
    expect((await ceo.call('delete', '/v2/admin/orders/MB-ORD-DEL-1').send({ reason: 'no' })).status).toBe(422);
    const gone = await ceo.call('delete', '/v2/admin/orders/MB-ORD-DEL-1').send({ reason: 'Raised by mistake' });
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
    expect(gone.body).toMatchObject({ deleted: true, status: 'cancelled', stockRestored: true });
    const row = await OrderModel.findOne({ reference: 'MB-ORD-DEL-1' }).lean();
    expect(row).toMatchObject({ status: 'cancelled', deleteReason: 'Raised by mistake' });
    expect(row?.deletedAt).toBeTruthy();
    expect(row?.cancellation?.reason).toBe('Raised by mistake');
    expect(row?.timeline?.some((t) => t.label === 'Order deleted')).toBe(true);
    expect((await ProductModel.findOne({ reference: 'LOT-DEL-1' }).lean())?.availableGrams).toBe(4000);
    expect((await QuotationModel.findOne({ number: 'Q-DEL-1' }).lean())?.status).toBe('expired');
    expect(await AuditLog.countDocuments({ action: 'Order deleted', 'record.id': 'MB-ORD-DEL-1' })).toBe(1);

    // It disappears from the console, the list, the counts and search, but stays readable by reference.
    const snap = await ceo.call('get', '/v2/admin/console');
    expect(snap.body.orders.some((o: { id: string }) => o.id === 'MB-ORD-DEL-1')).toBe(false);
    const list = await ceo.call('get', '/v2/admin/orders?q=DEL-1');
    expect(list.body.items).toHaveLength(0);
    const found = await ceo.call('get', '/v2/admin/search?q=MB-ORD-DEL-1');
    expect(found.body.orders).toHaveLength(0);
    expect((await ceo.call('get', '/v2/admin/orders/MB-ORD-DEL-1')).status).toBe(200);
    const again = await ceo.call('delete', '/v2/admin/orders/MB-ORD-DEL-1').send({ reason: 'Delete it twice' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('order/already-deleted');
    expect((await ceo.call('delete', '/v2/admin/orders/MB-ORD-NOPE').send({ reason: 'Does not exist' })).status).toBe(404);

    // A released payout always blocks deletion, even with force.
    const released = await makeOrder('MB-ORD-DEL-2');
    await SellerPayoutModel.create({
      orderId: released._id,
      userId: String(buyer._id),
      amount: usd(100),
      status: 'released',
      destination: { payoutAccountId: 'pac_it_1', method: 'bank', display: 'Bank ****1234' },
    });
    const blockedPayout = await ceo.call('delete', '/v2/admin/orders/MB-ORD-DEL-2').send({ reason: 'Try to delete', force: true });
    expect(blockedPayout.status, JSON.stringify(blockedPayout.body)).toBe(409);
    expect(blockedPayout.body.code).toBe('order/payout-released');

    // A confirmed payment blocks it unless forced by someone with the finance permission.
    const paid = await makeOrder('MB-ORD-DEL-3', { settlement: { method: 'bank', status: 'held' } });
    const blockedPaid = await ceo.call('delete', '/v2/admin/orders/MB-ORD-DEL-3').send({ reason: 'Customer withdrew' });
    expect(blockedPaid.status).toBe(409);
    expect(blockedPaid.body.code).toBe('order/payment-recorded');
    expect((await OrderModel.findById(paid._id).lean())?.deletedAt).toBeUndefined();
    const { createStaff } = await import('../src/modules/staff/staff.service.js');
    await createStaff({ email: 'ops.nofinance@mineralbridge.co.ke', password: PASSWORD, name: 'Ops No Finance', roleId: 'ROLE-DESK' });
    const ops = await signIn('ops.nofinance@mineralbridge.co.ke');
    const opsForce = await ops.call('delete', '/v2/admin/orders/MB-ORD-DEL-3').send({ reason: 'Customer withdrew', force: true });
    expect(opsForce.status, JSON.stringify(opsForce.body)).toBe(403);
    const forced = await ceo.call('delete', '/v2/admin/orders/MB-ORD-DEL-3').send({ reason: 'Customer withdrew', force: true });
    expect(forced.status, JSON.stringify(forced.body)).toBe(200);
    expect((await OrderModel.findById(paid._id).lean())?.status).toBe('cancelled');

    // Pending money-in on an unpaid order is cancelled with it.
    const unpaid = await makeOrder('MB-ORD-DEL-4', { workflow: { definition: 'buy.v2', stepKey: 'paid', stepIndex: 7, phase: 2, owner: 'customer', enteredAt: new Date() } });
    await PaymentModel.create({
      orderId: String(unpaid._id), userId: String(buyer._id), attempt: 1, method: 'bank_transfer', amount: usd(100), status: 'submitted',
    });
    const cleared = await ceo.call('delete', `/v2/admin/orders/MB-ORD-DEL-4?reason=${encodeURIComponent('Duplicate order')}`);
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect((await PaymentModel.findOne({ orderId: String(unpaid._id) }).lean())?.status).toBe('cancelled');
  });
});
