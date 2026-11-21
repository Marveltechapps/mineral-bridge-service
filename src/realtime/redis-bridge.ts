/**
 * Optional Redis pub/sub fan-out for the in-process RealtimeHub.
 *
 * When REDIS_URL is set, every locally published event is also published to Redis
 * (`mb:rt:<channel>`), and events from other instances are re-emitted locally
 * (without re-publishing, to avoid loops).
 *
 * Sequence numbers remain per-instance for local ring-buffer replay. Cross-instance
 * consumers should treat seq gaps as a signal to refetch — the same rule as before.
 *
 * Without REDIS_URL this module is a no-op and the hub stays single-process.
 */
import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import { loadEnv } from '../config/env.js';
import { logger } from '../config/logger.js';
import { realtimeHub, type HubEvent } from './auction-hub.js';

const CHANNEL_PREFIX = 'mb:rt:';
const instanceId = createHash('sha1').update(`${process.pid}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 12);

let pub: Redis | null = null;
let sub: Redis | null = null;
let started = false;

type WireEvent = HubEvent & { origin: string };

export function isRedisRealtimeEnabled(): boolean {
  return Boolean(loadEnv().REDIS_URL?.trim());
}

export async function startRedisRealtimeBridge(): Promise<void> {
  if (started) return;
  const url = loadEnv().REDIS_URL?.trim();
  if (!url) {
    logger.info('Realtime hub: in-process only (REDIS_URL unset)');
    return;
  }

  started = true;
  pub = new Redis(url, { maxRetriesPerRequest: 2, enableReadyCheck: true, lazyConnect: true });
  sub = new Redis(url, { maxRetriesPerRequest: 2, enableReadyCheck: true, lazyConnect: true });

  await Promise.all([pub.connect(), sub.connect()]);
  await sub.psubscribe(`${CHANNEL_PREFIX}*`);

  sub.on('pmessage', (_pattern, _redisChannel, message) => {
    try {
      const wire = JSON.parse(message) as WireEvent;
      if (!wire?.channel || wire.origin === instanceId) return;
      // Re-emit for local WS/SSE subscribers without calling publish() (would loop).
      realtimeHub.emit(wire.channel, wire as HubEvent);
    } catch (err) {
      logger.warn({ err }, 'Invalid realtime Redis message');
    }
  });

  const originalPublish = realtimeHub.publish.bind(realtimeHub);
  realtimeHub.publish = (channel, event, data, opts = {}) => {
    const evt = originalPublish(channel, event, data, opts);
    const wire: WireEvent = { ...evt, origin: instanceId };
    void pub!
      .publish(`${CHANNEL_PREFIX}${channel}`, JSON.stringify(wire))
      .catch((err) => logger.warn({ err, channel }, 'Realtime Redis publish failed'));
    return evt;
  };

  logger.info({ instanceId }, 'Realtime hub: Redis pub/sub bridge active');
}

export async function stopRedisRealtimeBridge(): Promise<void> {
  if (!started) return;
  started = false;
  try {
    await sub?.punsubscribe(`${CHANNEL_PREFIX}*`);
  } catch {
    /* ignore */
  }
  await Promise.allSettled([pub?.quit(), sub?.quit()]);
  pub = null;
  sub = null;
}
