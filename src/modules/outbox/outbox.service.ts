import { opaqueId } from '../../common/utils/ids.js';
import { logger } from '../../config/logger.js';
import { OutboxEventModel, type OutboxEventShape } from './outbox.model.js';

/** Persist a side-effect for later delivery. Never throws to callers of business paths. */
export async function enqueueOutbox(
  topic: string,
  payload: Record<string, unknown>,
): Promise<string | null> {
  try {
    const eventId = opaqueId('obx');
    await OutboxEventModel.create({
      eventId,
      topic,
      payload,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(),
    });
    return eventId;
  } catch (err) {
    logger.error({ err, topic }, 'outbox enqueue failed');
    return null;
  }
}

export async function claimPendingOutbox(limit = 20): Promise<OutboxEventShape[]> {
  const now = new Date();
  const docs = await OutboxEventModel.find({
    status: { $in: ['pending', 'failed'] },
    nextAttemptAt: { $lte: now },
  })
    .sort({ nextAttemptAt: 1 })
    .limit(limit)
    .lean();

  const claimed: OutboxEventShape[] = [];
  for (const doc of docs) {
    const updated = await OutboxEventModel.findOneAndUpdate(
      { eventId: doc.eventId, status: { $in: ['pending', 'failed'] } },
      { $set: { status: 'processing' }, $inc: { attempts: 1 } },
      { new: true },
    ).lean();
    if (updated) claimed.push(updated as OutboxEventShape);
  }
  return claimed;
}

export async function markOutboxDelivered(eventId: string): Promise<void> {
  await OutboxEventModel.updateOne(
    { eventId },
    { $set: { status: 'delivered', deliveredAt: new Date() } },
  );
}

export async function markOutboxFailed(eventId: string, error: string, maxAttempts = 8): Promise<void> {
  const doc = await OutboxEventModel.findOne({ eventId }).lean();
  if (!doc) return;
  const attempts = doc.attempts ?? 1;
  const dead = attempts >= maxAttempts;
  const backoffMs = Math.min(60_000 * 2 ** Math.min(attempts, 6), 3_600_000);
  await OutboxEventModel.updateOne(
    { eventId },
    {
      $set: {
        status: dead ? 'dead' : 'failed',
        lastError: error.slice(0, 500),
        nextAttemptAt: new Date(Date.now() + backoffMs),
      },
    },
  );
}
