import type { NotificationKind } from '../../models/notification.model.js';

/** Canonical notification events -> per-client vocabulary (kind, icon, tone/severity, deep link). */
export type EventMeta = {
  kind: NotificationKind;
  mobileKind: string;
  iconKey: string;
  tone: 'info' | 'warn' | 'done' | 'gold' | 'live';
  webKind: string;
  severity: 'info' | 'warning' | 'success' | 'error';
  webRoute: string;
};

export const EVENT_CATALOG: Record<string, EventMeta> = {
  'auction.outbid': { kind: 'auction', mobileKind: 'auction_outbid', iconKey: 'gavel', tone: 'warn', webKind: 'auction_outbid', severity: 'warning', webRoute: 'auctionDetail' },
  'auction.won': { kind: 'auction', mobileKind: 'auction_won', iconKey: 'trophy', tone: 'done', webKind: 'auction_won', severity: 'success', webRoute: 'auctionDetail' },
  'auction.ending': { kind: 'auction', mobileKind: 'auction_ending', iconKey: 'clock', tone: 'warn', webKind: 'auction_ending', severity: 'info', webRoute: 'auctionDetail' },
  'auction.opening': { kind: 'auction', mobileKind: 'auction_opening', iconKey: 'gavel', tone: 'info', webKind: 'auction_opening', severity: 'info', webRoute: 'auctionDetail' },
  'order.stage_changed': { kind: 'order', mobileKind: 'order_in_transit', iconKey: 'truck', tone: 'info', webKind: 'order_stage', severity: 'info', webRoute: 'orderDetail' },
  'order.quote_ready': { kind: 'order', mobileKind: 'order_quote_ready', iconKey: 'file', tone: 'gold', webKind: 'order_stage', severity: 'info', webRoute: 'orderDetail' },
  'order.delivered': { kind: 'order', mobileKind: 'order_delivered', iconKey: 'check', tone: 'done', webKind: 'order_stage', severity: 'success', webRoute: 'orderDetail' },
  'sell.offer_ready': { kind: 'sell', mobileKind: 'sell_offer_ready', iconKey: 'tag', tone: 'gold', webKind: 'sell_offer', severity: 'info', webRoute: 'sell' },
  'sell.evaluator_assigned': { kind: 'sell', mobileKind: 'sell_evaluator_assigned', iconKey: 'user', tone: 'info', webKind: 'sell_offer', severity: 'info', webRoute: 'sell' },
  'sell.paid': { kind: 'sell', mobileKind: 'sell_paid', iconKey: 'bank', tone: 'done', webKind: 'sell_offer', severity: 'success', webRoute: 'sell' },
  'sell.status_changed': { kind: 'sell', mobileKind: 'sell_evaluator_assigned', iconKey: 'user', tone: 'info', webKind: 'sell_status', severity: 'info', webRoute: 'asm' },
  'kyc.decided': { kind: 'kyc', mobileKind: 'kyc_approved', iconKey: 'shield', tone: 'done', webKind: 'kyc_decided', severity: 'success', webRoute: 'kyc' },
  'document.expiring': { kind: 'system', mobileKind: 'document_expiring', iconKey: 'file', tone: 'warn', webKind: 'document_reviewed', severity: 'warning', webRoute: 'account' },
  'document.reviewed': { kind: 'system', mobileKind: 'document_expiring', iconKey: 'file', tone: 'info', webKind: 'document_reviewed', severity: 'info', webRoute: 'account' },
  'payout.paid': { kind: 'payout', mobileKind: 'payout_paid', iconKey: 'bank', tone: 'done', webKind: 'payout_verified', severity: 'success', webRoute: 'account' },
  'payout.verified': { kind: 'payout', mobileKind: 'payout_paid', iconKey: 'bank', tone: 'done', webKind: 'payout_verified', severity: 'success', webRoute: 'account' },
  'support.reply': { kind: 'support', mobileKind: 'support_reply', iconKey: 'chat', tone: 'info', webKind: 'support_reply', severity: 'info', webRoute: 'account' },
  'lc.status_changed': { kind: 'lc', mobileKind: 'order_quote_ready', iconKey: 'file', tone: 'info', webKind: 'lc_status', severity: 'info', webRoute: 'lc' },
  'negotiation.offer': { kind: 'negotiation', mobileKind: 'order_quote_ready', iconKey: 'chat', tone: 'info', webKind: 'negotiation_offer', severity: 'info', webRoute: 'negotiation' },
  'contract.signed': { kind: 'contract', mobileKind: 'order_quote_ready', iconKey: 'file', tone: 'done', webKind: 'contract_signed', severity: 'success', webRoute: 'contract' },
  'learn.new_lesson': { kind: 'system', mobileKind: 'learn_new_lesson', iconKey: 'book', tone: 'info', webKind: 'learn_new_lesson', severity: 'info', webRoute: 'academy' },
};

export const FALLBACK_META: EventMeta = {
  kind: 'system',
  mobileKind: 'system',
  iconKey: 'bell',
  tone: 'info',
  webKind: 'order_stage',
  severity: 'info',
  webRoute: 'home',
};

export function metaFor(event: string): EventMeta {
  return EVENT_CATALOG[event] ?? FALLBACK_META;
}
