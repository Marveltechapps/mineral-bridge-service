/**
 * BUG-008: Admin payment drawer stores bank reference in form.pref; payOk stepPayload must send it.
 * @tags bugfix dashboard payments
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../MB-Dashboard/src/lib/adminApi.ts', () => ({
  adminApi: { post: vi.fn(), get: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  adminRequest: vi.fn(),
  AdminApiError: class AdminApiError extends Error {},
}));
vi.mock('../../../MB-Dashboard/src/services/console/consoleService.ts', () => ({
  getConsoleDb: vi.fn(async () => ({ live: false })),
}));

const { stepPayload } = await import('../../../MB-Dashboard/src/modules/console/engine/liveBridge.ts');

describe('bugfix dashboard BUG-008 payOk reference field', () => {
  it('bug_008_payok_pref_maps_to_confirmedRef: payment drawer field pref is posted as confirmedRef', () => {
    expect(stepPayload('payOk', { kind: 'buy' }, { pref: 'TRX-UG-9912' })).toEqual({
      confirmedRef: 'TRX-UG-9912',
    });
  });

  it('bug_008_payok_ref_still_wins: explicit ref is still accepted when set', () => {
    expect(stepPayload('payOk', { kind: 'buy' }, { ref: 'TRX-A', pref: 'TRX-B' })).toEqual({
      confirmedRef: 'TRX-A',
    });
  });

  it('bug_008_payok_quote_neighbour: quote step payload is unchanged', () => {
    const order = { kind: 'buy', items: [{ lot: 'LOT-1' }] };
    expect(stepPayload('quote', order, { fee: 1, valid: 7, price0: 50 })).toMatchObject({
      feeMinor: 100,
      validDays: 7,
    });
  });
});