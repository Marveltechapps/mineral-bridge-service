import type { INotification } from '../../models/notification.model.js';
import { agoDisplay } from '../../common/utils/time-display.js';
import { now } from '../../common/utils/clock.js';
import { metaFor } from './notifications.events.js';

/**
 * The record a notification points at wins over the event's default screen.
 * `order.stage_changed` is also how shipment updates are delivered, and those
 * must open shipment tracking rather than an order.
 */
const TARGET_ROUTE: Record<string, string> = {
  order: 'orderDetail',
  auction: 'auctionDetail',
  listing: 'sell',
  sell_request: 'sell',
  lc: 'lc',
  contract: 'contract',
  negotiation: 'negotiation',
  shipment: 'shipment',
  asm: 'asm',
  ticket: 'account',
};

const ACCOUNT_TAB: Record<string, string> = {
  'document.expiring': 'documents',
  'document.reviewed': 'documents',
  'payout.paid': 'payouts',
  'payout.verified': 'payouts',
  'support.reply': 'support',
};

/** Deep link the web client can follow. `route` is a frontend route key. */
export function webActionFor(event: string, target?: { type: string; id: string }) {
  const meta = metaFor(event);
  const type = target?.type;
  let route = (type && TARGET_ROUTE[type]) || meta.webRoute;
  const params: Record<string, string> = {};
  if (target?.id) params.id = target.id;
  if (type) params.type = type;
  const tab = ACCOUNT_TAB[event] ?? (type === 'ticket' ? 'support' : undefined);
  if (tab) params.tab = tab;
  if (event === 'learn.new_lesson' && target?.id) route = 'course';
  return { label: 'View', route, params };
}

function mobileKindFor(n: INotification, fallback: string): string {
  if (n.event !== 'kyc.decided') return fallback;
  const decision = String((n.data as { decision?: string } | undefined)?.decision ?? '');
  if (decision === 'rejected') return 'kyc_rejected';
  if (decision === 'resubmission_required') return 'kyc_resubmission';
  return fallback;
}

export function toMobileNotification(n: INotification) {
  const meta = metaFor(n.event);
  return {
    id: n._id,
    kind: mobileKindFor(n, meta.mobileKind),
    title: n.title,
    body: n.body,
    createdAt: n.createdAt.toISOString(),
    agoDisplay: agoDisplay(n.createdAt, now()),
    read: Boolean(n.readAt),
    iconKey: meta.iconKey,
    tone: meta.tone,
    target: n.target ? { kind: n.target.type, id: n.target.id } : null,
  };
}

export function toWebNotification(n: INotification) {
  const meta = metaFor(n.event);
  return {
    id: n._id,
    kind: meta.webKind,
    title: n.title,
    body: n.body,
    read: Boolean(n.readAt),
    createdAt: n.createdAt.toISOString(),
    severity: meta.severity,
    action: webActionFor(n.event, n.target),
    data: n.data ?? {},
  };
}
