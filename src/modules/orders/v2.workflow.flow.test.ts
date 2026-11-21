import { describe, expect, it } from 'vitest';
import { BUY_V2_STEPS, SELL_V2_STEPS, stepIndex } from '../workflow/workflow.definitions.js';
import { advanceWorkflow, assertCurrent, startWorkflow } from '../workflow/workflow.service.js';

describe('buy.v2 / sell.v2 definitions', () => {
  it('buy path includes contract and payment gates', () => {
    const keys = BUY_V2_STEPS.map((s) => s.key);
    expect(keys).toContain('accepted');
    expect(keys).toContain('quoteOk');
    expect(keys).toContain('contract');
    expect(keys).toContain('paid');
    expect(keys).toContain('payOk');
    expect(keys).toContain('receipt');
    expect(keys).toContain('done');
    expect(stepIndex('buy.v2', 'paid')).toBeLessThan(stepIndex('buy.v2', 'payOk'));
  });

  it('sell path includes inspection and payout', () => {
    const keys = SELL_V2_STEPS.map((s) => s.key);
    expect(keys).toContain('reviewed');
    expect(keys).toContain('reportOk');
    expect(keys).toContain('payout');
    expect(keys).toContain('done');
  });

  it('customer can move quoteOk → confirmed → contract → paid after staff countersign path', () => {
    let w = startWorkflow('buy.v2', 'quoteOk');
    assertCurrent(w, 'quoteOk');
    w = advanceWorkflow(w, 'confirmed', { kind: 'customer', id: 'c1' });
    w = advanceWorkflow(w, 'contract', { kind: 'staff', id: 's1' });
    w = advanceWorkflow(w, 'contractMb', { kind: 'customer', id: 'c1' });
    w = advanceWorkflow(w, 'paid', { kind: 'staff', id: 's1' });
    expect(w.current.key).toBe('paid');
    expect(w.current.owner).toBe('customer');
  });
});
