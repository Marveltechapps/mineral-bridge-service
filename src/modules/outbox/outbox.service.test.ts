import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./outbox.model.js', () => {
  const store: Array<Record<string, unknown>> = [];
  return {
    OutboxEventModel: {
      create: vi.fn(async (doc: Record<string, unknown>) => {
        store.push({ ...doc });
        return doc;
      }),
      find: vi.fn(() => ({
        sort: () => ({
          limit: () => ({
            lean: async () => store.filter((d) => d.status === 'pending' || d.status === 'failed'),
          }),
        }),
      })),
      findOneAndUpdate: vi.fn(async (filter: { eventId: string }, update: { $set: Record<string, unknown>; $inc?: { attempts: number } }) => {
        const doc = store.find((d) => d.eventId === filter.eventId);
        if (!doc) return null;
        Object.assign(doc, update.$set);
        if (update.$inc?.attempts) doc.attempts = Number(doc.attempts ?? 0) + update.$inc.attempts;
        return { lean: async () => doc, ...doc };
      }),
      updateOne: vi.fn(async (filter: { eventId: string }, update: { $set: Record<string, unknown> }) => {
        const doc = store.find((d) => d.eventId === filter.eventId);
        if (doc) Object.assign(doc, update.$set);
      }),
      findOne: vi.fn((filter: { eventId: string }) => ({
        lean: async () => store.find((d) => d.eventId === filter.eventId) ?? null,
      })),
      __store: store,
    },
  };
});

describe('outbox enqueue', () => {
  beforeEach(async () => {
    const mod = await import('./outbox.model.js');
    (mod.OutboxEventModel as unknown as { __store: unknown[] }).__store.length = 0;
  });

  it('enqueues a pending event', async () => {
    const { enqueueOutbox } = await import('./outbox.service.js');
    const id = await enqueueOutbox('order.placed', { userId: 'u1', orderId: 'o1' });
    expect(id).toBeTruthy();
  });
});
