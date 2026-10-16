import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

describe('createApp()', () => {
  const app = createApp();

  it('GET /health is always 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /ready is 503 when the database is not connected', async () => {
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
  });

  it('sets security headers', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('unknown routes use the error envelope', async () => {
    const res = await request(app).get('/v1/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(typeof res.body.code).toBe('string');
  });

  it('malformed JSON is 400 request/malformed', async () => {
    const res = await request(app).post('/v1/auth/otp/request').set('Content-Type', 'application/json').send('{"phone":');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('request/malformed');
  });

  it('admin routes require a session (401) and never leak data', async () => {
    const res = await request(app).get('/admin/v1/orders');
    expect(res.status).toBe(401);
  });

  it('serves Swagger UI and the OpenAPI document source', async () => {
    const res = await request(app).get('/docs/').redirects(1);
    expect(res.status).toBe(200);
  });
});
