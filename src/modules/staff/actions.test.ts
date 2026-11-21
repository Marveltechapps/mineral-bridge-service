import { describe, expect, it } from 'vitest';
import { actionsForRoleKey, staffHasAction, STAFF_ACTIONS } from './actions.js';

describe('staff actions RBAC', () => {
  it('super has every action', () => {
    for (const a of STAFF_ACTIONS) {
      expect(staffHasAction({ roleKey: 'super' }, a)).toBe(true);
    }
  });

  it('compliance can kyc and suspend', () => {
    expect(staffHasAction({ roleKey: 'compliance' }, 'kyc')).toBe(true);
    expect(staffHasAction({ roleKey: 'compliance' }, 'suspend')).toBe(true);
    expect(staffHasAction({ roleKey: 'compliance' }, 'finance')).toBe(false);
  });

  it('explicit actions[] overrides role defaults', () => {
    expect(staffHasAction({ roleKey: 'support', actions: ['finance'] }, 'finance')).toBe(true);
    expect(staffHasAction({ roleKey: 'support', actions: ['finance'] }, 'support')).toBe(false);
  });

  it('actionsForRoleKey returns copies', () => {
    const a = actionsForRoleKey('ops');
    const b = actionsForRoleKey('ops');
    expect(a).toEqual(b);
    a.push('settings');
    expect(b).not.toContain('settings');
  });
});
