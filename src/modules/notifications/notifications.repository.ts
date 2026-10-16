import type { FilterQuery } from 'mongoose';
import { DeviceModel, NotificationModel, NotificationPrefsModel } from '../../models/notification.model.js';
import type { IDevice, INotification, INotificationPrefs } from '../../models/notification.model.js';
export const notificationsRepository = {
  create(doc: Omit<INotification, '_id' | 'createdAt'>): Promise<INotification> {
    return NotificationModel.create(doc).then((d) => d.toObject() as INotification);
  },

  async list(filter: FilterQuery<INotification>, skip: number, limit: number) {
    const [rows, total] = await Promise.all([
      NotificationModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean<INotification[]>(),
      NotificationModel.countDocuments(filter),
    ]);
    return { rows, total };
  },

  countUnread(userId: string): Promise<number> {
    return NotificationModel.countDocuments({ userId, readAt: { $exists: false } });
  },

  async markOneRead(userId: string, id: string): Promise<boolean> {
    const found = await NotificationModel.findOne({ _id: id, userId }).select('_id').lean();
    if (!found) return false;
    await NotificationModel.updateOne({ _id: id, userId, readAt: { $exists: false } }, { $set: { readAt: new Date() } });
    return true;
  },

  async markAllRead(userId: string): Promise<number> {
    const res = await NotificationModel.updateMany({ userId, readAt: { $exists: false } }, { $set: { readAt: new Date() } });
    return res.modifiedCount;
  },

  upsertDevice(userId: string, d: Pick<IDevice, 'token' | 'platform' | 'deviceId' | 'appVersion'>) {
    return DeviceModel.findOneAndUpdate(
      { token: d.token },
      { $set: { userId, platform: d.platform, deviceId: d.deviceId, appVersion: d.appVersion, lastSeenAt: new Date() } },
      { upsert: true, new: true },
    ).lean();
  },

  async deleteDevice(userId: string, token: string): Promise<void> {
    await DeviceModel.deleteOne({ userId, token });
  },

  async prefs(userId: string): Promise<INotificationPrefs> {
    const doc = await NotificationPrefsModel.findOneAndUpdate(
      { _id: userId },
      { $setOnInsert: { push: true, email: true, sms: false, kinds: {} } },
      { upsert: true, new: true },
    ).lean<INotificationPrefs>();
    return doc!;
  },

  async updatePrefs(userId: string, set: Record<string, unknown>): Promise<INotificationPrefs> {
    const doc = await NotificationPrefsModel.findOneAndUpdate({ _id: userId }, { $set: set }, { upsert: true, new: true }).lean<INotificationPrefs>();
    return doc!;
  },
};
