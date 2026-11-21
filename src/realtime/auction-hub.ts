import { EventEmitter } from 'node:events';

/**
 * In-process realtime hub (EventEmitter based). Services publish *domain* events (minor-unit
 * integers, ISO strings); the WebSocket/SSE layer maps them to each client's frame format.
 *
 * - One monotonic `seq` per channel (web frames expose it; a gap tells the client to refetch).
 * - A small ring buffer per channel enables `Last-Event-ID` / `since` replay.
 * - `to` targets a single user (e.g. `bidder.outbid`).
 *
 * Multi-instance: set REDIS_URL to enable the Redis pub/sub bridge in redis-bridge.ts.
 * Without REDIS_URL this hub is single-process only.
 */

export type HubEvent = {
  channel: string;
  seq: number;
  event: string;
  at: string;
  data: Record<string, unknown>;
  to?: string;
};

export type HubListener = (evt: HubEvent) => void;

export const channels = {
  auction: (id: string) => `auction:${id}`,
  sellRequest: (id: string) => `sell-request:${id}`,
  chat: (id: string) => `chat:${id}`,
  negotiation: (id: string) => `negotiation:${id}`,
  user: (id: string) => `user:${id}`,
} as const;

export class RealtimeHub extends EventEmitter {
  private readonly seqs = new Map<string, number>();
  private readonly buffers = new Map<string, HubEvent[]>();

  constructor(private readonly bufferSize = 200) {
    super();
    this.setMaxListeners(0);
  }

  publish(channel: string, event: string, data: Record<string, unknown>, opts: { to?: string; at?: Date } = {}): HubEvent {
    const seq = (this.seqs.get(channel) ?? 0) + 1;
    this.seqs.set(channel, seq);
    const evt: HubEvent = {
      channel,
      seq,
      event,
      at: (opts.at ?? new Date()).toISOString(),
      data,
      ...(opts.to ? { to: opts.to } : {}),
    };
    const buf = this.buffers.get(channel) ?? [];
    buf.push(evt);
    if (buf.length > this.bufferSize) buf.shift();
    this.buffers.set(channel, buf);
    this.emit(channel, evt);
    return evt;
  }

  subscribe(channel: string, listener: HubListener): () => void {
    this.on(channel, listener);
    return () => {
      this.off(channel, listener);
    };
  }

  /** Events with `seq > since` still in the ring buffer. */
  replaySince(channel: string, since: number): HubEvent[] {
    return (this.buffers.get(channel) ?? []).filter((e) => e.seq > since);
  }

  currentSeq(channel: string): number {
    return this.seqs.get(channel) ?? 0;
  }

  listenerCountFor(channel: string): number {
    return this.listenerCount(channel);
  }

  reset(): void {
    this.removeAllListeners();
    this.seqs.clear();
    this.buffers.clear();
  }
}

/** Auction-flavoured publisher helpers over the generic hub. */
export class AuctionHub extends RealtimeHub {
  bidPlaced(d: {
    auctionId: string;
    bidId: string;
    bidderId: string;
    bidderLabel: string;
    amountMinor: number;
    currency: string;
    placedAt: string;
    bidCount: number;
    highestMinor: number;
    minimumNextMinor: number;
    reserveMet: boolean;
    version: number;
    kind: string;
  }): HubEvent {
    return this.publish(channels.auction(d.auctionId), 'bid.placed', d);
  }

  outbid(d: {
    auctionId: string;
    auctionName: string;
    outbidUserId: string;
    newHighestMinor: number;
    yourBidMinor: number;
    currency: string;
    closesAt: string;
  }): HubEvent {
    return this.publish(channels.auction(d.auctionId), 'bidder.outbid', d, { to: d.outbidUserId });
  }

  extended(d: { auctionId: string; closesAt: string; version: number }): HubEvent {
    return this.publish(channels.auction(d.auctionId), 'auction.extended', d);
  }

  closing(d: { auctionId: string; secondsRemaining: number }): HubEvent {
    return this.publish(channels.auction(d.auctionId), 'auction.closing', d);
  }

  closed(d: {
    auctionId: string;
    result: 'sold' | 'reserve_not_met' | 'no_bids';
    winnerId: string | null;
    winningMinor: number | null;
    currency: string;
    settlementOrderId: string | null;
  }): HubEvent {
    return this.publish(channels.auction(d.auctionId), 'auction.closed', d);
  }
}

export const auctionHub = new AuctionHub();
/** Shared singleton; `auctionHub` is the same instance. */
export const realtimeHub: RealtimeHub = auctionHub;
