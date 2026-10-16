import { StateMachine } from '../../common/utils/state-machine.js';
import type { OrderSide, OrderStatus } from '../../models/order.model.js';

export type StageDef = { key: string; title: string; subtitle: string };

export const BUY_STAGES: StageDef[] = [
  { key: 'verification', title: 'Verification desk review', subtitle: 'Assay and origin documents re-checked. Within 24 hours.' },
  { key: 'quote_issued', title: 'Verified quote issued', subtitle: 'Final weight, price and transport cost sent for approval.' },
  { key: 'escrow_funded', title: 'Escrow funded', subtitle: 'Payment held by Mineral Bridge escrow.' },
  { key: 'released', title: 'Sealed and released from vault', subtitle: 'Tamper seal photographed and logged.' },
  { key: 'in_transit', title: 'In transit', subtitle: 'Bonded carrier en route to your facility.' },
  { key: 'delivered', title: 'Delivered and confirmed', subtitle: 'You confirm the seal and assay, then escrow releases.' },
];

export const SELL_STAGES: StageDef[] = [
  { key: 'submitted', title: 'Submitted', subtitle: 'Your sale request has been received.' },
  { key: 'collection', title: 'Agent collection', subtitle: 'An agent collects the lot from your site.' },
  { key: 'assay', title: 'Assay lab', subtitle: 'Independent assay of weight and purity.' },
  { key: 'vault', title: 'Received in MB vault', subtitle: 'Lot sealed and logged into the vault.' },
  { key: 'settlement', title: 'Settlement pending', subtitle: 'Final price confirmed, payment queued.' },
  { key: 'paid', title: 'Paid', subtitle: 'Proceeds released to your payout account.' },
];

export const stagesFor = (side: OrderSide): StageDef[] => (side === 'buy' ? BUY_STAGES : SELL_STAGES);
export const STAGE_COUNT = 6;

export type DocTemplate = { kind: string; name: string; availableFromStage: number };

export const BUY_DOCS: DocTemplate[] = [
  { kind: 'order_confirmation', name: 'Order confirmation', availableFromStage: 0 },
  { kind: 'verified_quote', name: 'Verified quote', availableFromStage: 1 },
  { kind: 'escrow_receipt', name: 'Escrow receipt', availableFromStage: 2 },
  { kind: 'assay_certificate', name: 'Assay certificate', availableFromStage: 2 },
  { kind: 'waybill', name: 'Waybill and seal photos', availableFromStage: 3 },
  { kind: 'delivery_note', name: 'Delivery note', availableFromStage: 5 },
];

export const SELL_DOCS: DocTemplate[] = [
  { kind: 'intake_receipt', name: 'Intake receipt', availableFromStage: 0 },
  { kind: 'weight_certificate', name: 'Weight certificate', availableFromStage: 1 },
  { kind: 'assay_certificate', name: 'Assay certificate', availableFromStage: 2 },
  { kind: 'sale_agreement', name: 'Sale agreement', availableFromStage: 3 },
  { kind: 'payment_advice', name: 'Payment advice', availableFromStage: 5 },
];

export const docsFor = (side: OrderSide): DocTemplate[] => (side === 'buy' ? BUY_DOCS : SELL_DOCS);

/** Order lifecycle: cancel only before escrow is funded (enforced in the service); rejection is terminal. */
export const orderMachine = new StateMachine<OrderStatus>(
  'order',
  {
    pending_review: ['active', 'rejected', 'cancelled'],
    active: ['completed', 'rejected', 'cancelled'],
    completed: [],
    rejected: [],
    cancelled: [],
  },
  'order/invalid-transition',
);

/** Canonical status derived from the pipeline position. */
export function statusForStage(stageIndex: number): OrderStatus {
  if (stageIndex >= STAGE_COUNT - 1) return 'completed';
  return stageIndex === 0 ? 'pending_review' : 'active';
}

/** Mobile status vocabulary (X-7). */
export const MOBILE_BUY_STATUS = ['verifying', 'quote_issued', 'escrow_funded', 'released', 'in_transit', 'delivered'] as const;
export const MOBILE_BUY_LABEL = [
  'VERIFICATION DESK REVIEW',
  'QUOTE ISSUED',
  'ESCROW FUNDED',
  'RELEASED FROM VAULT',
  'IN TRANSIT',
  'DELIVERED',
] as const;
