import { notFound } from '../../common/errors/app-error.js';
import { channels, realtimeHub } from '../../realtime/auction-hub.js';
import type { INotification } from '../../models/notification.model.js';
import { EVENT_CATALOG, metaFor } from './notifications.events.js';
import { notificationsRepository as repo } from './notifications.repository.js';

export type NotifyInput = {
  event: string;
  title: string;
  body?: string;
  target?: { type: string; id: string };
  data?: Record<string, unknown>;
};

/** Persist an in-app notification and fan it out to the user's SSE channel. Never throws to callers. */
export async function notifyUser(userId: string, input: NotifyInput): Promise<INotification | null> {
  try {
    const meta = metaFor(input.event);
    const doc = await repo.create({
      userId,
      kind: meta.kind,
      event: input.event,
      title: input.title,
      body: input.body ?? '',
      target: input.target,
      data: input.data,
    });
    realtimeHub.publish(channels.user(userId), 'notification.created', {
      notificationId: doc._id,
      event: doc.event,
      title: doc.title,
      body: doc.body,
      target: doc.target ?? null,
      createdAt: doc.createdAt.toISOString(),
    });
    return doc;
  } catch {
    return null;
  }
}

export const notificationsService = {
  async listCursor(userId: string, q: { limit: number; skip: number; unread?: boolean }) {
    const filter = { userId, ...(q.unread ? { readAt: { $exists: false } } : {}) };
    const [{ rows, total }, unreadCount] = await Promise.all([repo.list(filter, q.skip, q.limit), repo.countUnread(userId)]);
    return { rows, total, unreadCount };
  },

  async listPaged(userId: string, q: { skip: number; perPage: number; unreadOnly?: boolean; webKind?: string }) {
    const filter: Record<string, unknown> = { userId };
    if (q.unreadOnly) filter.readAt = { $exists: false };
    if (q.webKind) {
      const events = Object.entries(EVENT_CATALOG)
        .filter(([, m]) => m.webKind === q.webKind)
        .map(([e]) => e);
      filter.event = { $in: events };
    }
    const [{ rows, total }, unreadCount] = await Promise.all([repo.list(filter, q.skip, q.perPage), repo.countUnread(userId)]);
    return { rows, total, unreadCount };
  },

  async markRead(userId: string, id: string): Promise<number> {
    const ok = await repo.markOneRead(userId, id);
    if (!ok) throw notFound('notification/not-found', 'Notification not found');
    return repo.countUnread(userId);
  },

  async markAllRead(userId: string): Promise<{ markedCount: number; unreadCount: number }> {
    const markedCount = await repo.markAllRead(userId);
    return { markedCount, unreadCount: 0 };
  },

  async registerDevice(userId: string, d: { token: string; platform: 'ios' | 'android' | 'web'; deviceId?: string; appVersion?: string }) {
    await repo.upsertDevice(userId, d);
  },

  unregisterDevice: (userId: string, token: string) => repo.deleteDevice(userId, token),

  async updatePreferences(
    userId: string,
    input: { channels?: { email?: boolean; sms?: boolean; push?: boolean }; kinds?: Record<string, boolean> },
  ) {
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input.channels ?? {})) {
      if (v !== undefined) set[k] = v;
    }
    for (const [k, v] of Object.entries(input.kinds ?? {})) {
      set[`kinds.${k.replace(/[.$]/g, '_')}`] = v;
    }
    return Object.keys(set).length ? repo.updatePrefs(userId, set) : repo.prefs(userId);
  },
};
