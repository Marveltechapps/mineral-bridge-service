import type { ClientSession } from 'mongoose';
import { nextId } from '../../../common/db/sequence.js';
import { StaffNotification } from '../../../models/platform.models.js';
import type { PermissionModule } from '../../../models/shared.js';

/** Adds an item to the staff "needs attention" bell for everyone with view access on `module`. */
export async function notifyStaff(input: {
  module: PermissionModule;
  text: string;
  severity?: 'low' | 'medium' | 'high';
  target?: { type: string; id: string };
  staffId?: string | null;
  meta?: string;
  session?: ClientSession;
}): Promise<string> {
  const notificationId = await nextId('notification');
  await StaffNotification.create(
    [
      {
        notificationId,
        module: input.module,
        text: input.text,
        meta: input.meta,
        severity: input.severity ?? 'medium',
        target: input.target,
        staffId: input.staffId ?? null,
        createdAt: new Date(),
      },
    ],
    { session: input.session },
  );
  return notificationId;
}

export function timeAgo(d: Date | string | number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - new Date(d).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}
