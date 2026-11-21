import { logger } from '../../config/logger.js';
import { notifyUser } from '../notifications/notifications.service.js';
import {
  claimPendingOutbox,
  markOutboxDelivered,
  markOutboxFailed,
} from './outbox.service.js';

/**
 * Processes outbox events into in-app notifications (and future email/SMS providers).
 * Safe to run on an interval from the API process; multi-instance claims are optimistic.
 */
export async function processOutboxBatch(limit = 25): Promise<{ processed: number; failed: number }> {
  const claimed = await claimPendingOutbox(limit);
  let processed = 0;
  let failed = 0;
  for (const evt of claimed) {
    try {
      const payload = evt.payload ?? {};
      const userId = typeof payload.userId === 'string' ? payload.userId : undefined;
      if (userId) {
        await notifyUser(userId, {
          event: evt.topic,
          title: String(payload.title ?? evt.topic),
          body: String(payload.body ?? ''),
          target: payload.orderId
            ? { type: 'order', id: String(payload.orderId) }
            : payload.target && typeof payload.target === 'object'
              ? (payload.target as { type: string; id: string })
              : undefined,
          data: payload,
        });
      }
      await markOutboxDelivered(evt.eventId);
      processed += 1;
    } catch (err) {
      failed += 1;
      await markOutboxFailed(evt.eventId, err instanceof Error ? err.message : 'unknown');
      logger.warn({ err, eventId: evt.eventId, topic: evt.topic }, 'outbox delivery failed');
    }
  }
  return { processed, failed };
}

let timer: NodeJS.Timeout | null = null;

export function startOutboxWorker(intervalMs = 5_000): void {
  if (timer) return;
  timer = setInterval(() => {
    void processOutboxBatch().catch((err) => logger.error({ err }, 'outbox worker tick failed'));
  }, intervalMs);
  timer.unref();
  logger.info({ intervalMs }, 'outbox worker started');
}

export function stopOutboxWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
