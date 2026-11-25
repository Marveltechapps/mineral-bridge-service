import { describe, expect, it } from 'vitest';
import {
  discrepancyResolved,
  isNonCompliant,
  LEGACY_SELL_CONDITION,
  sellApprovalBlocks,
  sellQuoteCondition,
  type SellApprovalInput,
} from '../src/modules/admin/v2/sell-approval.js';

function ready(over: Partial<SellApprovalInput> = {}): SellApprovalInput {
  return {
    side: 'sell',
    declaredQty: 2,
    declaredGrade: '88%',
    agencyName: 'Intertek',
    weighed: 2,
    certifiedQty: 2,
    report: { no: '123456', grade: '88%', result: 'Compliant', remarks: '' },
    holdType: null,
    holdReason: null,
    timeline: [],
    ...over,
  };
}

describe('sell final approval', () => {
  it('allows a compliant inspection when quantity and grade match', () => {
    expect(sellApprovalBlocks(ready())).toEqual([]);
  });

  it('keeps a non-compliant report blocked and does not treat it as compliant', () => {
    expect(isNonCompliant('Non-compliant')).toBe(true);
    expect(isNonCompliant('non_compliant')).toBe(true);
    expect(isNonCompliant('Compliant')).toBe(false);
    expect(isNonCompliant('Compliant with remarks')).toBe(false);
    const blocks = sellApprovalBlocks(ready({
      report: { no: '123456', grade: '88%', result: 'Non-compliant', remarks: '' },
    }));
    expect(blocks.join(' ')).toMatch(/non-compliant/);
    expect(blocks.join(' ')).toMatch(/123456/);
    expect(blocks.join(' ')).not.toMatch(/now compliant/i);
  });

  it('blocks an unresolved quantity difference and allows it after it is resolved', () => {
    const open = sellApprovalBlocks(ready({ certifiedQty: 1.5, weighed: 1.5 }));
    expect(open.join(' ')).toMatch(/Quantity discrepancy is unresolved/);
    const resolved = sellApprovalBlocks(ready({
      certifiedQty: 1.5,
      weighed: 1.5,
      timeline: [{ label: 'Hold cleared', note: 'Discrepancy resolved: seller accepted the certified weight' }],
    }));
    expect(resolved).toEqual([]);
    expect(discrepancyResolved([{ note: 'Discrepancy resolved: accepted' }])).toBe(true);
  });

  it('blocks a pending discrepancy and a rejected discrepancy', () => {
    expect(sellApprovalBlocks(ready({ holdType: 'discrepancy', holdReason: '[qty:pending] short weight' })).join(' ')).toMatch(/pending/);
    expect(sellApprovalBlocks(ready({ holdType: 'discrepancy', holdReason: '[qty:rejected] scale photo unclear' })).join(' ')).toMatch(/rejected/);
  });

  it('blocks missing agency, weight, and report without changing a saved result', () => {
    const blocks = sellApprovalBlocks(ready({
      agencyName: '',
      weighed: null,
      certifiedQty: null,
      report: null,
    }));
    expect(blocks).toHaveLength(3);
  });

  it('names the assigned agency on the quotation condition', () => {
    expect(sellQuoteCondition(LEGACY_SELL_CONDITION, 'Intertek')).toBe('Subject to Mineral Bridge inspection and Intertek test report');
    expect(sellQuoteCondition(LEGACY_SELL_CONDITION, 'SGS Nigeria')).toBe('Subject to Mineral Bridge inspection and SGS Nigeria test report');
    expect(sellQuoteCondition('Subject to a private assay', 'Intertek')).toBe('Subject to a private assay');
  });
});
