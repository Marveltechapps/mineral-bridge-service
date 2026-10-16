import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROLES,
  findDefaultRoleByName,
  getDefaultRole,
  noPermissions,
  permissionsForRole,
} from './default-roles.js';
import { PERMISSION_MODULES } from './staff.types.js';

describe('default role matrix', () => {
  it('defines the six contract roles', () => {
    expect(DEFAULT_ROLES.map((r) => r.id)).toEqual([
      'ROLE-CEO',
      'ROLE-DESK',
      'ROLE-COMPLIANCE',
      'ROLE-CONTENT',
      'ROLE-SUPPORT',
      'ROLE-CLERK',
    ]);
  });

  it('covers all ten modules for every role', () => {
    expect(PERMISSION_MODULES).toHaveLength(10);
    for (const role of DEFAULT_ROLES) {
      expect(Object.keys(role.access).sort()).toEqual([...PERMISSION_MODULES].sort());
    }
  });

  it('gives the CEO edit on everything', () => {
    expect(Object.values(getDefaultRole('ROLE-CEO')!.access).every((l) => l === 'edit')).toBe(true);
  });

  it('matches the contract for the trading desk', () => {
    expect(getDefaultRole('ROLE-DESK')!.access).toMatchObject({
      orders: 'edit',
      vault: 'edit',
      pricing: 'edit',
      auctions: 'edit',
      users: 'view',
      compliance: 'view',
      content: 'none',
      financial: 'view',
      settings: 'none',
      support: 'view',
    });
  });

  it('matches the contract for compliance, content, support and clerk', () => {
    expect(getDefaultRole('ROLE-COMPLIANCE')!.access).toMatchObject({ compliance: 'edit', pricing: 'none', orders: 'view' });
    expect(getDefaultRole('ROLE-CONTENT')!.access).toMatchObject({ content: 'edit', orders: 'none', support: 'none' });
    expect(getDefaultRole('ROLE-SUPPORT')!.access).toMatchObject({ support: 'edit', users: 'view', vault: 'none' });
    expect(getDefaultRole('ROLE-CLERK')!.access).toMatchObject({ vault: 'edit', orders: 'view', financial: 'none' });
  });

  it('only the CEO can edit settings', () => {
    const editors = DEFAULT_ROLES.filter((r) => r.access.settings === 'edit').map((r) => r.id);
    expect(editors).toEqual(['ROLE-CEO']);
  });

  it('permissionsForRole returns a copy', () => {
    const a = permissionsForRole('ROLE-CLERK');
    a.vault = 'none';
    expect(permissionsForRole('ROLE-CLERK').vault).toBe('edit');
  });

  it('looks roles up by name case-insensitively and throws for unknown ids', () => {
    expect(findDefaultRoleByName('  support agent ')?.id).toBe('ROLE-SUPPORT');
    expect(findDefaultRoleByName('nope')).toBeUndefined();
    expect(() => permissionsForRole('ROLE-NOPE')).toThrow();
  });

  it('noPermissions grants nothing', () => {
    expect(Object.values(noPermissions()).every((l) => l === 'none')).toBe(true);
  });
});
