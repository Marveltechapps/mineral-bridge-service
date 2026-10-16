import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../common/utils/crypto.js';
import {
  evaluatePinState,
  fromWebKycStatus,
  hasRole,
  initialsOf,
  isValidPinFormat,
  isWeakPin,
  lockedFieldsFor,
  toWebKycStatus,
  validateCustomerPassword,
} from './user.service.js';

describe('password hashing', () => {
  it('hashes with bcrypt, salts, and verifies', async () => {
    const hash = await hashPassword('Correct-Horse-9');
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(hash).not.toContain('Correct-Horse-9');
    expect(await verifyPassword('Correct-Horse-9', hash)).toBe(true);
    expect(await verifyPassword('correct-horse-9', hash)).toBe(false);
    expect(await hashPassword('Correct-Horse-9')).not.toBe(hash);
  });
});

describe('validateCustomerPassword', () => {
  it('accepts >= 10 chars with an uppercase letter and a digit or symbol', () => {
    expect(validateCustomerPassword('Abcdefghi1')).toBeNull();
    expect(validateCustomerPassword('Abcdefghi!')).toBeNull();
  });
  it('rejects short, no-uppercase and no-digit-or-symbol passwords', () => {
    expect(validateCustomerPassword('Abcdefg1')).toMatch(/10 characters/);
    expect(validateCustomerPassword('abcdefghi1')).toMatch(/uppercase/);
    expect(validateCustomerPassword('Abcdefghij')).toMatch(/digit or symbol/);
  });
  it('caps the length', () => {
    expect(validateCustomerPassword(`A1${'a'.repeat(200)}`)).toMatch(/at most/);
  });
});

describe('PIN rules', () => {
  it('requires exactly four digits', () => {
    expect(isValidPinFormat('4821')).toBe(true);
    expect(isValidPinFormat('482')).toBe(false);
    expect(isValidPinFormat('48211')).toBe(false);
    expect(isValidPinFormat('48a1')).toBe(false);
  });
  it('rejects repeated and sequential PINs', () => {
    for (const weak of ['0000', '1111', '1234', '4321', '2345', '9876']) expect(isWeakPin(weak)).toBe(true);
    for (const ok of ['4821', '1357', '2580', '1243']) expect(isWeakPin(ok)).toBe(false);
  });
  it('derives the PIN state', () => {
    const now = new Date('2026-10-16T10:00:00Z');
    expect(evaluatePinState({}, now)).toBe('not_set');
    expect(evaluatePinState({ pinHash: 'h' }, now)).toBe('ok');
    expect(evaluatePinState({ pinHash: 'h', pinLockedUntil: new Date(now.getTime() + 1000) }, now)).toBe('locked');
    expect(evaluatePinState({ pinHash: 'h', pinLockedUntil: new Date(now.getTime() - 1000) }, now)).toBe('ok');
  });
});

describe('KYC status mapping (W-4)', () => {
  it('maps none <-> unverified and leaves the rest alone', () => {
    expect(toWebKycStatus('none')).toBe('unverified');
    expect(toWebKycStatus('pending')).toBe('pending');
    expect(toWebKycStatus('verified')).toBe('verified');
    expect(toWebKycStatus('rejected')).toBe('rejected');
    expect(fromWebKycStatus('unverified')).toBe('none');
    expect(fromWebKycStatus('pending')).toBe('pending');
  });
});

describe('helpers', () => {
  it('initialsOf', () => {
    expect(initialsOf('Adaeze Okonkwo')).toBe('AO');
    expect(initialsOf('  madonna ')).toBe('M');
    expect(initialsOf('Ngozi Chioma Eze')).toBe('NE');
    expect(initialsOf(undefined)).toBe('');
  });
  it('hasRole: "both" satisfies buyer and seller but not bank_operator', () => {
    expect(hasRole(['both'], 'buyer')).toBe(true);
    expect(hasRole(['both'], 'seller')).toBe(true);
    expect(hasRole(['both'], 'bank_operator')).toBe(false);
    expect(hasRole(['buyer'], 'seller')).toBe(false);
  });
  it('lockedFieldsFor pads locks after verification', () => {
    expect(lockedFieldsFor({ phoneVerifiedAt: undefined, kycStatus: 'none' })).toEqual([]);
    expect(lockedFieldsFor({ phoneVerifiedAt: new Date(), kycStatus: 'none' })).toEqual(['phone']);
    expect(lockedFieldsFor({ phoneVerifiedAt: new Date(), kycStatus: 'verified' })).toEqual([
      'phone',
      'dateOfBirth',
      'fullName',
    ]);
  });
});
