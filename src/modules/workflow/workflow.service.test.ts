import { describe, expect, it } from 'vitest';
import { AppError } from '../../common/errors/app-error.js';
import { advanceWorkflow, assertCurrent, startWorkflow } from './workflow.service.js';

describe('workflow.service', () => {
  it('starts buy.v2 at accepted', () => {
    const w = startWorkflow('buy.v2', 'accepted');
    expect(w.definition).toBe('buy.v2');
    expect(w.current.key).toBe('accepted');
    expect(w.current.owner).toBe('ops');
    expect(w.version).toBe(1);
  });

  it('advances with version check', () => {
    const w = startWorkflow('buy.v2', 'accepted');
    const next = advanceWorkflow(w, 'quoteOk', { kind: 'staff', id: 'stf_1' }, 'priced');
    expect(next.current.key).toBe('quoteOk');
    expect(next.version).toBe(2);
    expect(() => advanceWorkflow(next, 'confirmed', { kind: 'customer', id: 'u1' }, undefined, 1)).toThrow(AppError);
  });

  it('assertCurrent rejects wrong step', () => {
    const w = startWorkflow('sell.v2', 'reviewed');
    expect(() => assertCurrent(w, 'quoteOk')).toThrow(AppError);
    expect(() => assertCurrent(w, 'reviewed')).not.toThrow();
  });
});
