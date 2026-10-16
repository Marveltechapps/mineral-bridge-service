import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, clearDb, createUser, seedProduct, startDb, stopDb, WEB } from './helpers/harness.js';
import { LetterOfCreditModel, WalletModel, LedgerModel, NegotiationModel } from '../src/models/index.js';
import { lcsService } from '../src/modules/lcs/lcs.service.js';
import { consumeWsTicket, signWsTicket } from '../src/realtime/ws-auth.js';

vi.mock('../src/modules/auth/auth.middleware.js', async () => await import('./helpers/fake-auth.js'));

const app = buildApp();
beforeAll(startDb);
afterAll(stopDb);
beforeEach(clearDb);

const offer = (perKg = 5_000_000, quantity = 10) => ({
  price: { amount: perKg, currency: 'USD' },
  unit: 'kg',
  quantity,
  incoterm: 'FOB',
  namedPort: 'Tema',
  shipmentFrom: '2026-12-01',
  shipmentTo: '2026-12-20',
});

const as = (userId: string) => ({ ...WEB, 'x-test-user': userId });

async function startNegotiation(buyer: string, lotId: string, key = 'neg-key-0001') {
  return request(app).post('/v1/negotiations').set(as(buyer)).set('Idempotency-Key', key).send({ lotId, offer: offer() });
}

async function agreedNegotiation() {
  const buyer = await createUser();
  const seller = await createUser();
  const lot = await seedProduct({ sellerId: seller });
  const start = await startNegotiation(buyer, lot._id);
  expect(start.status).toBe(201);
  const neg = start.body;
  const accept = await request(app).post(`/v1/negotiations/${neg.id}/offers/${neg.openOfferId}/accept`).set(as(seller));
  expect(accept.status).toBe(200);
  return { buyer, seller, negId: neg.id as string };
}

describe('negotiations', () => {
  it('start is idempotent per key and only one live negotiation exists per buyer+lot', async () => {
    const buyer = await createUser();
    const seller = await createUser();
    const lot = await seedProduct({ sellerId: seller });

    const a = await startNegotiation(buyer, lot._id);
    const b = await startNegotiation(buyer, lot._id);
    expect(a.status).toBe(201);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.body.id).toBe(a.body.id);

    const c = await startNegotiation(buyer, lot._id, 'neg-key-0002');
    expect(c.status).toBe(409);
    expect(c.body.code).toBe('negotiation/already-open');
    expect(await NegotiationModel.countDocuments({})).toBe(1);
  });

  it('concurrent accept / reject / counter on one open offer: exactly one wins, the rest get 409', async () => {
    const buyer = await createUser();
    const seller = await createUser();
    const lot = await seedProduct({ sellerId: seller });
    const neg = (await startNegotiation(buyer, lot._id)).body;

    const results = await Promise.all([
      request(app).post(`/v1/negotiations/${neg.id}/offers/${neg.openOfferId}/accept`).set(as(seller)),
      request(app).post(`/v1/negotiations/${neg.id}/offers/${neg.openOfferId}/reject`).set(as(seller)),
      request(app).post(`/v1/negotiations/${neg.id}/offers/${neg.openOfferId}/counter`).set(as(seller)).send(offer(5_500_000)),
      request(app).post(`/v1/negotiations/${neg.id}/offers/${neg.openOfferId}/counter`).set(as(seller)).send(offer(5_200_000)),
    ]);
    expect(results.filter((r) => r.status < 300)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);

    const fresh = await NegotiationModel.findById(neg.id).lean();
    expect(fresh!.offers.filter((o) => o.state === 'open').length).toBeLessThanOrEqual(1);
  });

  it('the author cannot accept their own offer', async () => {
    const buyer = await createUser();
    const seller = await createUser();
    const lot = await seedProduct({ sellerId: seller });
    const neg = (await startNegotiation(buyer, lot._id)).body;
    const r = await request(app).post(`/v1/negotiations/${neg.id}/offers/${neg.openOfferId}/accept`).set(as(buyer));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('negotiation/own-offer');
  });

  it('outsiders cannot see a negotiation', async () => {
    const buyer = await createUser();
    const seller = await createUser();
    const stranger = await createUser();
    const lot = await seedProduct({ sellerId: seller });
    const neg = (await startNegotiation(buyer, lot._id)).body;
    expect((await request(app).get(`/v1/negotiations/${neg.id}`).set(as(stranger))).status).toBe(404);
  });
});

describe('contract -> LC -> payment', () => {
  it('runs the full chain; signing twice and editing signed terms are 409; payment credits exactly once', async () => {
    const { buyer, seller, negId } = await agreedNegotiation();

    const created = await request(app).post('/v1/contracts').set(as(buyer)).send({ negotiationId: negId, issuingBankId: '044' });
    expect(created.status).toBe(201);
    const again = await request(app).post('/v1/contracts').set(as(seller)).send({ negotiationId: negId, issuingBankId: '044' });
    expect(again.body.id).toBe(created.body.id); // one live contract per negotiation
    const cid = created.body.id as string;

    expect((await request(app).post(`/v1/contracts/${cid}/sign`).set(as(buyer)).send({ signatory: 'Buyer Signer' })).status).toBe(200);
    const dup = await request(app).post(`/v1/contracts/${cid}/sign`).set(as(buyer)).send({ signatory: 'Buyer Signer' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('contract/already-signed');
    const locked = await request(app).patch(`/v1/contracts/${cid}`).set(as(seller)).send({ tenor: '30 days' });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('contract/terms-locked');
    const full = await request(app).post(`/v1/contracts/${cid}/sign`).set(as(seller)).send({ signatory: 'Seller Signer' });
    expect(full.body.status).toBe('countersigned');
    expect(full.body.anchor.hash).toBe(full.body.termsHash);

    const doc = await request(app).get(`/v1/contracts/${cid}/document`).set(as(buyer));
    expect(doc.status).toBe(200);
    expect(doc.body.url).toContain('/v1/files/signed/contract/');

    // LC: only the buyer applies; repeat is the same LC.
    expect((await request(app).post('/v1/lcs').set(as(seller)).send({ contractId: cid })).status).toBe(404);
    const [l1, l2] = await Promise.all([
      request(app).post('/v1/lcs').set(as(buyer)).send({ contractId: cid }),
      request(app).post('/v1/lcs').set(as(buyer)).send({ contractId: cid }),
    ]);
    expect(l1.body.id).toBe(l2.body.id);
    const lcId = l1.body.id as string;
    expect(await LetterOfCreditModel.countDocuments({})).toBe(1);

    // Bank portal: unassigned operators are refused; assigned ones issue and advise.
    const bank = await createUser();
    expect((await request(app).get('/v1/bank/lcs').set(as(bank))).body.code).toBe('lc/bank-not-assigned');
    await lcsService.bank.grant(bank, ['044']);
    expect((await request(app).post(`/v1/bank/lcs/${lcId}/advise`).set(as(bank)).send({})).status).toBe(409); // not issued yet
    expect((await request(app).post(`/v1/bank/lcs/${lcId}/issue`).set(as(bank))).body.status).toBe('Issued');
    expect((await request(app).post(`/v1/bank/lcs/${lcId}/advise`).set(as(bank)).send({})).body.status).toBe('Advised');
    const otherBank = await createUser();
    await lcsService.bank.grant(otherBank, ['058']);
    expect((await request(app).get(`/v1/bank/lcs/${lcId}`).set(as(otherBank))).status).toBe(404);

    // Presenting without a precheck is refused; a compliant set of documents is accepted.
    expect((await request(app).post(`/v1/lcs/${lcId}/presentation`).set(as(seller)).send({})).body.code).toBe('lc/precheck-required');
    const lc = (await LetterOfCreditModel.findById(lcId).lean())!;
    const docs = ['invoice', 'bl', 'packing', 'origin', 'assay'].map((key) => ({
      key,
      fileId: `fil_${key}`,
      uploadedAt: new Date(),
      extracted: key === 'bl' ? { onBoardDate: new Date().toISOString().slice(0, 10) } : key === 'invoice' ? { amountMinor: String(lc.amount.amountMinor), goods: lc.goodsDescription } : {},
    }));
    await LetterOfCreditModel.updateOne({ _id: lcId }, { $set: { documents: docs } });
    const pre = await request(app).post(`/v1/lcs/${lcId}/precheck`).set(as(seller));
    expect(pre.body.precheck.compliant).toBe(true);
    expect((await request(app).post(`/v1/lcs/${lcId}/presentation`).set(as(buyer)).send({})).status).toBe(403); // beneficiary only
    expect((await request(app).post(`/v1/lcs/${lcId}/presentation`).set(as(seller)).send({})).body.status).toBe('Presented');
    expect((await request(app).post(`/v1/bank/lcs/${lcId}/payment`).set(as(bank))).status).toBe(409); // not examined

    const exam = await request(app).post(`/v1/bank/lcs/${lcId}/examination`).set(as(bank)).send({ decision: 'accepted' });
    expect(exam.body.status).toBe('Examined');

    // Concurrent, repeated payment requests: every caller sees Paid, the seller is credited once.
    const pays = await Promise.all(Array.from({ length: 6 }, () => request(app).post(`/v1/bank/lcs/${lcId}/payment`).set(as(bank)).send({})));
    expect(pays.every((p) => p.status === 200 && p.body.status === 'Paid')).toBe(true);
    const wallet = await WalletModel.findById(seller).lean();
    expect(wallet!.availableMinor).toBe(lc.amount.amountMinor);
    expect(await LedgerModel.countDocuments({ userId: seller, kind: 'sale_proceeds' })).toBe(1);
  });

  it('a late shipment is flagged and needs explicit acknowledgement to present', async () => {
    const { buyer, seller, negId } = await agreedNegotiation();
    const cid = (await request(app).post('/v1/contracts').set(as(buyer)).send({ negotiationId: negId, issuingBankId: '044' })).body.id as string;
    await request(app).post(`/v1/contracts/${cid}/sign`).set(as(buyer)).send({ signatory: 'B S' });
    await request(app).post(`/v1/contracts/${cid}/sign`).set(as(seller)).send({ signatory: 'S S' });
    const lcId = (await request(app).post('/v1/lcs').set(as(buyer)).send({ contractId: cid })).body.id as string;
    const bank = await createUser();
    await lcsService.bank.grant(bank, ['044']);
    await request(app).post(`/v1/bank/lcs/${lcId}/issue`).set(as(bank));
    await request(app).post(`/v1/bank/lcs/${lcId}/advise`).set(as(bank)).send({});
    const lc = (await LetterOfCreditModel.findById(lcId).lean())!;
    const docs = ['invoice', 'bl', 'packing', 'origin', 'assay'].map((key) => ({ key, fileId: `fil_${key}`, uploadedAt: new Date(), extracted: key === 'bl' ? { onBoardDate: '2999-01-01' } : {} }));
    await LetterOfCreditModel.updateOne({ _id: lcId }, { $set: { documents: docs } });
    const pre = await request(app).post(`/v1/lcs/${lcId}/precheck`).set(as(seller));
    expect(pre.body.precheck.compliant).toBe(false);
    expect(pre.body.precheck.discrepancies.map((d: { code: string }) => d.code)).toContain('LATE_SHIPMENT');
    const blocked = await request(app).post(`/v1/lcs/${lcId}/presentation`).set(as(seller)).send({});
    expect(blocked.body.code).toBe('lc/discrepancies-unacknowledged');
    const ok = await request(app).post(`/v1/lcs/${lcId}/presentation`).set(as(seller)).send({ acknowledgeDiscrepancies: true });
    expect(ok.body.status).toBe('Presented');
    expect(lc.status).toBe('Advised');
  });
});

describe('listings and ASM', () => {
  it('listing quote is server-computed; create is idempotent and drafts are editable until submitted', async () => {
    const user = await createUser();
    const body = { mineralId: 'AU', quantity: { value: 2, unit: 'kg' }, verificationAddress: { city: 'Kumasi', country: 'GH' } };
    const quote = await request(app).post('/v1/listings/quote').set(as(user)).send(body);
    expect(quote.status).toBe(200);
    expect(quote.body.quote.net.amount).toBeGreaterThan(0);
    expect(quote.body.quote.net.amount).toBeLessThan(quote.body.quote.gross.amount);

    const mk = () => request(app).post('/v1/listings').set(as(user)).set('Idempotency-Key', 'lst-key-0001').send(body);
    const [a, b] = await Promise.all([mk(), mk()]);
    expect([a.status, b.status].every((s) => s === 201)).toBe(true);
    expect(a.body.id).toBe(b.body.id);
    const noPhoto = await request(app).patch(`/v1/listings/${a.body.id}`).set(as(user)).send({ submit: true });
    expect(noPhoto.body.code).toBe('listing/photos-required');
  });

  it('ASM: ineligible answers are refused; incomplete registrations cannot be submitted', async () => {
    const user = await createUser();
    const no = await request(app).post('/v1/asm/registrations').set(as(user)).send({ answers: [0, 1, 2, 3, 4].map((index) => ({ index, answer: index !== 0 })) });
    expect(no.status).toBe(422);
    const yes = await request(app).post('/v1/asm/registrations').set(as(user)).send({ answers: [0, 1, 2, 3, 4].map((index) => ({ index, answer: true })) });
    expect(yes.status).toBe(201);
    const submit = await request(app).post(`/v1/asm/registrations/${yes.body.id}/submit`).set(as(user));
    expect(submit.status).toBe(422);
    expect(submit.body.code).toBe('asm/incomplete');
    const gps = await request(app).put(`/v1/asm/registrations/${yes.body.id}/gps`).set(as(user)).send({ latitude: 6.69, longitude: -1.62 });
    expect(gps.body.gps.latitude).toBe(6.69);
  });
});

describe('ws tickets', () => {
  it('are single-use and bound to the signature', () => {
    const t = signWsTicket('usr_1', 'web');
    expect(consumeWsTicket(t.token)).toMatchObject({ ok: true, userId: 'usr_1', client: 'web' });
    expect(consumeWsTicket(t.token).ok).toBe(false);
    const forged = signWsTicket('usr_2', 'web').token.replace(/^[^.]+/, Buffer.from(JSON.stringify({ sub: 'admin', cli: 'web', jti: 'x', exp: 9999999999 })).toString('base64url'));
    expect(consumeWsTicket(forged).ok).toBe(false);
    expect(consumeWsTicket(t.token, Date.now() + 120_000).ok).toBe(false);
  });
});

describe('schema', () => {
  it('every customer model builds its indexes on a real MongoDB (no unsupported partial-index specs)', async () => {
    const models = Object.values(mongoose.models);
    expect(models.length).toBeGreaterThan(30);
    await Promise.all(models.map((m) => m.init()));
  });
});
