/** buy.v2 / sell.v2 step keys from docs 09–10 / 07 AORD-05. */

export type WorkflowDefinitionId = 'buy.v2' | 'sell.v2';

export interface WorkflowStepDef {
  key: string;
  label: string;
  owner: 'customer' | 'platform' | 'trading' | 'inspection' | 'logistics' | 'finance' | 'ops';
  /** Staff action key required to complete this step when owner ≠ customer. */
  action?: 'ops' | 'trading' | 'finance' | 'inspection' | 'logistics';
}

export const BUY_V2_STEPS: readonly WorkflowStepDef[] = [
  { key: 'accepted', label: 'Under review', owner: 'ops', action: 'ops' },
  { key: 'quote', label: 'Pricing', owner: 'trading', action: 'trading' },
  { key: 'quoteOk', label: 'Quotation ready', owner: 'customer' },
  { key: 'confirmed', label: 'Confirmed', owner: 'trading', action: 'trading' },
  { key: 'contract', label: 'Contract', owner: 'customer' },
  { key: 'contractMb', label: 'Platform countersign', owner: 'trading', action: 'trading' },
  { key: 'paid', label: 'Payment', owner: 'customer' },
  { key: 'payOk', label: 'Payment confirmation', owner: 'finance', action: 'finance' },
  { key: 'assigned', label: 'Assign logistics', owner: 'logistics', action: 'logistics' },
  { key: 'picked', label: 'Picked up', owner: 'logistics', action: 'logistics' },
  { key: 'transit', label: 'In transit', owner: 'logistics', action: 'logistics' },
  { key: 'delivered', label: 'Delivered', owner: 'logistics', action: 'logistics' },
  { key: 'receipt', label: 'Confirm receipt', owner: 'customer' },
  { key: 'done', label: 'Completed', owner: 'ops', action: 'ops' },
] as const;

export const SELL_V2_STEPS: readonly WorkflowStepDef[] = [
  { key: 'reviewed', label: 'Under review', owner: 'ops', action: 'ops' },
  { key: 'quote', label: 'Offer', owner: 'trading', action: 'trading' },
  { key: 'quoteOk', label: 'Quotation ready', owner: 'customer' },
  { key: 'confirmed', label: 'Confirmed', owner: 'trading', action: 'trading' },
  { key: 'contract', label: 'Contract', owner: 'customer' },
  { key: 'contractMb', label: 'Platform countersign', owner: 'trading', action: 'trading' },
  { key: 'form', label: 'Seller confirmation', owner: 'customer' },
  { key: 'formOk', label: 'Form received', owner: 'ops', action: 'ops' },
  { key: 'schedule', label: 'Schedule inspection', owner: 'inspection', action: 'inspection' },
  { key: 'inspect', label: 'Inspection', owner: 'inspection', action: 'inspection' },
  { key: 'sgs', label: 'Lab report', owner: 'inspection', action: 'inspection' },
  { key: 'reportOk', label: 'Review reports', owner: 'customer' },
  { key: 'approved', label: 'Approved for payout', owner: 'ops', action: 'ops' },
  { key: 'payout', label: 'Payout', owner: 'finance', action: 'finance' },
  { key: 'ship', label: 'Logistics', owner: 'logistics', action: 'logistics' },
  { key: 'delivered', label: 'Delivered', owner: 'logistics', action: 'logistics' },
  { key: 'done', label: 'Completed', owner: 'ops', action: 'ops' },
] as const;

export function stepsFor(definition: WorkflowDefinitionId): readonly WorkflowStepDef[] {
  return definition === 'buy.v2' ? BUY_V2_STEPS : SELL_V2_STEPS;
}

export function stepIndex(definition: WorkflowDefinitionId, key: string): number {
  const idx = stepsFor(definition).findIndex((s) => s.key === key);
  if (idx < 0) throw new Error(`Unknown step ${key} for ${definition}`);
  return idx;
}

export function stepDef(definition: WorkflowDefinitionId, key: string): WorkflowStepDef {
  const s = stepsFor(definition).find((x) => x.key === key);
  if (!s) throw new Error(`Unknown step ${key} for ${definition}`);
  return s;
}
