import { describe, expect, it } from 'vitest';
import { hashPassword } from '../../common/utils/crypto.js';
import {
  accessSatisfies,
  isPasswordInHistory,
  isStaffEmailDomainAllowed,
  validateStaffPassword,
} from './staff.service.js';

describe('accessSatisfies', () => {
  it('edit satisfies view and edit; view satisfies view; none and undefined satisfy nothing', () => {
    expect(accessSatisfies('edit', 'edit')).toBe(true);
    expect(accessSatisfies('edit', 'view')).toBe(true);
    expect(accessSatisfies('view', 'view')).toBe(true);
    expect(accessSatisfies('view', 'edit')).toBe(false);
    expect(accessSatisfies('none', 'view')).toBe(false);
    expect(accessSatisfies(undefined, 'view')).toBe(false);
  });
});

describe('validateStaffPassword', () => {
  it('requires at least 12 characters', () => {
    expect(validateStaffPassword('short-pass1')).toMatch(/12 characters/);
    expect(validateStaffPassword('twelve-chars')).toBeNull();
  });
  it('caps the length', () => {
    expect(validateStaffPassword('a'.repeat(129))).toMatch(/at most/);
  });
});

describe('isPasswordInHistory (not one of the last 5)', () => {
  it('detects reuse of any of the stored hashes', async () => {
    const history = [await hashPassword('first-password-1'), await hashPassword('second-password-2')];
    expect(await isPasswordInHistory('second-password-2', history)).toBe(true);
    expect(await isPasswordInHistory('brand-new-password-3', history)).toBe(false);
    expect(await isPasswordInHistory('anything', [])).toBe(false);
  });

  it('only considers the last five', async () => {
    const hashes = [];
    for (let i = 0; i < 6; i += 1) hashes.push(await hashPassword(`old-password-number-${i}`));
    // history is newest-first; the sixth (index 5) has aged out.
    expect(await isPasswordInHistory('old-password-number-0', hashes)).toBe(true);
    expect(await isPasswordInHistory('old-password-number-5', hashes)).toBe(false);
  });
});

describe('isStaffEmailDomainAllowed', () => {
  it('allows configured staff domains only', () => {
    expect(isStaffEmailDomainAllowed('ops@mineralbridge.com')).toBe(true);
    expect(isStaffEmailDomainAllowed('OPS@MineralBridge.com')).toBe(true);
    expect(isStaffEmailDomainAllowed('ops@gmail.com')).toBe(false);
    expect(isStaffEmailDomainAllowed('not-an-email')).toBe(false);
  });
});
