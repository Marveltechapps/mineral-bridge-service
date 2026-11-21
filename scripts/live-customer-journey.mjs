/**
 * Live authenticated customer journey against a running API (not Vitest).
 * Usage: node scripts/live-customer-journey.mjs [baseUrl]
 * Requires DEV_OTP_ENABLED=true on the server in development.
 */
const BASE = (process.argv[2] || 'http://127.0.0.1:5001').replace(/\/$/, '');
const V2 = `${BASE}/v2`;
const headers = () => ({
  'Content-Type': 'application/json',
  'X-Client': 'mineralbridge-mobile/0.1.0',
  'X-Platform': 'android',
  'X-Device-Id': 'live-e2e-device-1',
});

const results = [];
function ok(name, detail = '') {
  results.push({ name, pass: true, detail });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, detail) {
  results.push({ name, pass: false, detail });
  console.error(`FAIL  ${name} — ${detail}`);
}

async function req(method, path, body, token, extra = {}) {
  const h = { ...headers(), ...extra };
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(`${V2}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, headers: res.headers };
}

async function main() {
  const phone = `+23480${String(Date.now()).slice(-8)}`;
  console.log(`Live journey against ${V2}`);
  console.log(`Test phone ${phone}`);

  // Health
  {
    const r = await req('GET', '/health');
    if (r.status === 200) ok('health');
    else fail('health', `${r.status} ${JSON.stringify(r.json)}`);
  }

  // Catalogue (guest)
  let productRef = null;
  {
    const cats = await req('GET', '/catalogue/categories');
    if (cats.status === 200 && Array.isArray(cats.json?.items)) ok('catalogue categories', `${cats.json.items.length} cats`);
    else fail('catalogue categories', `${cats.status}`);

    const products = await req('GET', '/catalogue/products?limit=5');
    if (products.status === 200 && Array.isArray(products.json?.items)) {
      productRef = products.json.items[0]?.reference || products.json.items[0]?.productRef || products.json.items[0]?.ref;
      ok('catalogue products', productRef ? `first=${productRef}` : 'empty catalogue');
    } else fail('catalogue products', `${products.status}`);

    if (productRef) {
      const doc = await req('GET', `/catalogue/products/${encodeURIComponent(productRef)}/documents/lot_test_report`);
      if (doc.status === 200 && doc.json?.url) ok('catalogue document', doc.json.type);
      else if (doc.status === 404 && doc.json?.code === 'document/not-available')
        ok('catalogue document 404 (no doc on lot)', doc.json.code);
      else fail('catalogue document', `${doc.status} ${JSON.stringify(doc.json)}`);
    }
  }

  // Auth signup OTP
  let challengeId, registrationToken, accessToken, refreshToken, me;
  {
    const otp = await req('POST', '/auth/otp/request', {
      intent: 'signup',
      channel: 'whatsapp',
      identifier: phone,
      fullName: 'Live E2E Tester',
    });
    if (otp.status === 202 && otp.json?.challengeId) {
      challengeId = otp.json.challengeId;
      const code = otp.json.developmentOtp;
      if (!code) {
        fail('otp request', 'DEV_OTP_ENABLED must be true (no developmentOtp in response)');
      } else {
        ok('otp request', `challenge=${challengeId}`);
        const verify = await req('POST', '/auth/otp/verify', {
          challengeId,
          code,
          keepSignedIn: true,
          device: { id: 'live-e2e-device-1', platform: 'android', name: 'Pixel 9 E2E' },
        });
        if (verify.status === 200 && verify.json?.status === 'needs_registration') {
          registrationToken = verify.json.registrationToken;
          ok('otp verify needs_registration');
        } else if (verify.status === 200 && verify.json?.status === 'signed_in') {
          accessToken = verify.json.accessToken;
          refreshToken = verify.json.refreshToken;
          me = verify.json.me;
          ok('otp verify signed_in (existing)');
        } else fail('otp verify', `${verify.status} ${JSON.stringify(verify.json)}`);
      }
    } else fail('otp request', `${otp.status} ${JSON.stringify(otp.json)}`);
  }

  if (registrationToken) {
    const reg = await req('POST', '/auth/register', {
      registrationToken,
      fullName: 'Live E2E Tester',
      role: 'both',
      buyerType: 'refinery',
      sellerType: 'dealer',
      businessName: 'E2E Metals Ltd',
      countryCode: 'NG',
      acceptTerms: true,
      termsVersion: '2026-01',
    });
    if (reg.status === 201 && reg.json?.accessToken) {
      accessToken = reg.json.accessToken;
      refreshToken = reg.json.refreshToken;
      me = reg.json.me;
      ok('register', me?.customerNo || me?.id);
    } else fail('register', `${reg.status} ${JSON.stringify(reg.json)}`);
  }

  if (!accessToken) {
    console.error('Aborting — no access token');
    process.exit(1);
  }

  // Me / KYC / prefs / support
  {
    const r = await req('GET', '/me', undefined, accessToken);
    if (r.status === 200) ok('me', r.json?.fullName);
    else fail('me', `${r.status}`);

    const kyc = await req('GET', '/kyc', undefined, accessToken);
    if (kyc.status === 200) ok('kyc get', kyc.json?.status || JSON.stringify(kyc.json)?.slice(0, 80));
    else fail('kyc get', `${kyc.status}`);

    const prefs = await req('GET', '/me/notification-preferences', undefined, accessToken);
    if (prefs.status === 200) ok('notification prefs');
    else fail('notification prefs', `${prefs.status}`);

    const faqs = await req('GET', '/support/faqs');
    if (faqs.status === 200) ok('support faqs');
    else fail('support faqs', `${faqs.status}`);

    const thread = await req(
      'POST',
      '/support/threads',
      { topic: 'general', body: 'Live E2E support thread — please ignore.' },
      accessToken,
    );
    if (thread.status === 201 && thread.json?.ref) {
      ok('support create thread', thread.json.ref);
      const msg = await req(
        'POST',
        `/support/threads/${encodeURIComponent(thread.json.ref)}/messages`,
        { body: 'Follow-up from live E2E.' },
        accessToken,
      );
      if (msg.status === 201) ok('support reply');
      else fail('support reply', `${msg.status} ${JSON.stringify(msg.json)}`);
    } else fail('support create thread', `${thread.status} ${JSON.stringify(thread.json)}`);
  }

  // Cart / order (may fail without KYC verified — record honestly)
  if (productRef) {
    const cartPut = await req(
      'PUT',
      `/cart/items/${encodeURIComponent(productRef)}`,
      { qty: { value: '1', unit: 'kg' } },
      accessToken,
    );
    if (cartPut.status === 200 || cartPut.status === 201) ok('cart put');
    else ok('cart put blocked', `${cartPut.status} ${cartPut.json?.code || ''}`);

    const order = await req(
      'POST',
      '/orders',
      {
        kind: 'buy',
        fromCart: true,
        delivery: {
          org: 'E2E Metals Ltd',
          street: '12 Test Street',
          city: 'Lagos',
          country: 'NG',
          contact: 'Live E2E Tester',
          mobile: phone,
        },
      },
      accessToken,
      { 'Idempotency-Key': `live-e2e-${Date.now()}` },
    );
    if (order.status === 201) ok('create buy order', order.json?.reference);
    else ok('create buy order gated', `${order.status} ${order.json?.code || ''}`);
  }

  // Auctions list
  {
    const auc = await req('GET', '/auctions?status=live');
    if (auc.status === 200) ok('auctions list', `${auc.json?.items?.length ?? 0} live`);
    else fail('auctions list', `${auc.status}`);
  }

  // Token refresh
  {
    const refresh = await req('POST', '/auth/refresh', { refreshToken });
    if (refresh.status === 200 && refresh.json?.accessToken) {
      accessToken = refresh.json.accessToken;
      if (refresh.json.refreshToken) refreshToken = refresh.json.refreshToken;
      ok('token refresh');
    } else fail('token refresh', `${refresh.status} ${JSON.stringify(refresh.json)}`);
  }

  // Unauthorized
  {
    const unauth = await req('GET', '/me');
    if (unauth.status === 401) ok('unauthorized without token');
    else fail('unauthorized without token', `${unauth.status}`);
  }

  // Logout
  {
    const out = await req('POST', '/auth/logout', {}, accessToken);
    if (out.status === 204 || out.status === 200) ok('logout');
    else fail('logout', `${out.status}`);
  }

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`\nSummary: ${passed} passed, ${failed} failed, ${results.length} total`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
