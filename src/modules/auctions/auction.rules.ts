import { AppError } from '../../common/errors/app-error.js';
import type { ApiClient } from '../../common/middleware/request-context.js';
import { StateMachine } from '../../common/utils/state-machine.js';
import { MINUTE_MS } from '../../common/utils/clock.js';
import type { AuctionStatus, IAuction } from '../../models/auction.model.js';

/** One anti-sniping rule shared by every client (ARCHITECTURE §5.2). */
export const ANTI_SNIPE = { enabled: true, extendByMs: 2 * MINUTE_MS, withinMs: 2 * MINUTE_MS } as const;

export const auctionMachine = new StateMachine<AuctionStatus>(
  'auction',
  {
    draft: ['scheduled', 'cancelled'],
    scheduled: ['live', 'paused', 'ended', 'cancelled'],
    live: ['paused', 'ended', 'cancelled'],
    paused: ['live', 'ended', 'cancelled'],
    ended: [],
    cancelled: [],
  },
  'auction/invalid-transition',
);

export type EffectiveState = 'draft' | 'upcoming' | 'live' | 'paused' | 'ended' | 'cancelled';

/** Server-clock state; the stored `status` is lazily reconciled by finalisation. */
export function effectiveState(a: Pick<IAuction, 'status' | 'opensAt' | 'closesAt'>, at: Date): EffectiveState {
  if (a.status === 'draft') return 'draft';
  if (a.status === 'cancelled') return 'cancelled';
  if (a.status === 'ended') return 'ended';
  if (a.closesAt <= at) return 'ended';
  if (a.status === 'paused') return 'paused';
  if (a.opensAt > at) return 'upcoming';
  return 'live';
}

export function nextValidBidMinor(a: Pick<IAuction, 'highest' | 'startingBid' | 'minimumIncrement'>): number {
  return a.highest ? a.highest.amountMinor + a.minimumIncrement.amountMinor : a.startingBid.amountMinor;
}

export function reserveMet(a: Pick<IAuction, 'highest' | 'reserve'>): boolean {
  if (!a.highest) return false;
  return !a.reserve || a.highest.amountMinor >= a.reserve.amountMinor;
}

/** Anti-snipe: a bid in the final window pushes `closesAt` out by the extension. */
export function extendedCloseTime(closesAt: Date, at: Date): Date | null {
  if (!ANTI_SNIPE.enabled) return null;
  return closesAt.getTime() - at.getTime() <= ANTI_SNIPE.withinMs ? new Date(closesAt.getTime() + ANTI_SNIPE.extendByMs) : null;
}

/** Per-client error vocabulary (contract status codes differ for `auction/closed`). */
export const auctionErrors = {
  closed: (client: ApiClient) =>
    new AppError({ status: client === 'mobile' ? 410 : 409, code: 'auction/closed', message: 'This auction has closed.' }),
  notOpen: () => new AppError({ status: 409, code: 'auction/not-open', message: 'Bidding is not open for this auction.' }),
  tooLow: (floorMinor: number, currency: string) =>
    new AppError({
      status: 422,
      code: 'auction/bid-too-low',
      message: 'Bid is below the minimum next bid.',
      fields: { amount: String(floorMinor) },
      details: { minimumBid: { amount: floorMinor, currency } },
    }),
  selfOutbid: () => new AppError({ status: 422, code: 'auction/self-outbid', message: 'You already hold the highest bid.' }),
  outbid: (current: unknown) =>
    new AppError({ status: 409, code: 'auction/outbid', message: 'A higher bid landed before yours.', current }),
  currency: (expected: string) =>
    new AppError({
      status: 422,
      code: 'validation/failed',
      message: `Bids must be in ${expected}`,
      fields: { currency: `Must be ${expected}` },
    }),
};

/** Pseudonymous bidder labels for every customer client (X-8). Never leaks identity. */
export function bidderNumber(auctionId: string, bidderId: string): number {
  let h = 2166136261;
  const s = `${auctionId}:${bidderId}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return 1000 + (h % 9000);
}

export const bidderLabel = (auctionId: string, bidderId: string) => `Bidder #${bidderNumber(auctionId, bidderId)}`;
export const bidderInitials = (auctionId: string, bidderId: string) => `B${bidderNumber(auctionId, bidderId) % 10}`;
