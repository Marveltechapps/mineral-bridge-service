import type { INotification } from '../../models/notification.model.js';
import { agoDisplay } from '../../common/utils/time-display.js';
import { now } from '../../common/utils/clock.js';
import { metaFor } from './notifications.events.js';

export function toMobileNotification(n: INotification) {
  const meta = metaFor(n.event);
  return {
    id: n._id,
    kind: meta.mobileKind,
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
    action: n.target
      ? { label: 'View', route: meta.webRoute, params: { id: n.target.id } }
      : null,
    data: n.data ?? {},
  };
}
