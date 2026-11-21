import { describe, expect, it } from 'vitest';
import { AppError } from '../../common/errors/app-error.js';
import { normalizeV2Identifier, toMeDto } from './v2.auth.service.js';
import type { UserRecord } from '../users/user.types.js';

describe('normalizeV2Identifier', () => {
  it('normalises E.164 phones', () => {
    expect(normalizeV2Identifier('sms', '+2348034127790')).toBe('+2348034127790');
  });

  it('normalises emails', () => {
    expect(normalizeV2Identifier('email', 'Ada@Example.COM')).toBe('ada@example.com');
  });

  it('rejects bad phone', () => {
    try {
      normalizeV2Identifier('whatsapp', '08034127790');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('auth/invalid-identifier');
    }
  });
});

describe('toMeDto', () => {
  it('maps core profile fields', () => {
    const user = {
      id: 'abc',
      customerNo: 'C-5001',
      roles: ['both'],
      kycStatus: 'none',
      accountStatus: 'active',
      profile: { fullName: 'Ada', countryCode: 'NG' },
      business: { buyerType: 'refinery', name: 'Ada Metals' },
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      tier: 1,
      pinFailCount: 0,
      isDeleted: false,
      addresses: [],
      preferences: {
        language: 'en',
        currency: 'USD',
        units: 'metric',
        alerts: { bids: true, orders: true, lots: true, marketing: false },
        biometric: false,
      },
    } as UserRecord;

    const me = toMeDto(user);
    expect(me.customerNo).toBe('C-5001');
    expect(me.role).toBe('both');
    expect(me.business.isBusiness).toBe(true);
    expect(me.kyc.status).toBe('none');
  });
});
