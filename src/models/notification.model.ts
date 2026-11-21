import { defineModel, pk } from './_shared.js';

export type NotificationKind =
  | 'order'
  | 'auction'
  | 'sell'
  | 'kyc'
  | 'payout'
  | 'support'
  | 'negotiation'
  | 'contract'
  | 'lc'
  | 'shipment'
  | 'system';

export interface INotification {
  _id: string;
  userId: string;
  kind: NotificationKind;
  /** Canonical event name, e.g. `auction.outbid`, `order.stage_changed`. */
  event: string;
  title: string;
  body: string;
  /** Deep link target: { type, id } resolved to a screen/route by each client mapper. */
  target?: { type: string; id: string };
  orderId?: string;
  source?: { kind: 'system' | 'staff'; staffId?: string };
  channels?: Array<'push' | 'email' | 'sms' | 'whatsapp' | 'in_app'>;
  data?: Record<string, unknown>;
  readAt?: Date;
  createdAt: Date;
}

export const NotificationModel = defineModel<INotification>(
  'Notification',
  {
    _id: pk('ntf'),
    userId: { type: String, required: true },
    kind: { type: String, required: true },
    event: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, default: '' },
    target: { type: Object },
    orderId: String,
    source: {
      kind: { type: String, enum: ['system', 'staff'] },
      staffId: String,
    },
    channels: [{ type: String, enum: ['push', 'email', 'sms', 'whatsapp', 'in_app'] }],
    data: { type: Object },
    readAt: Date,
  },
  {
    indexes: [
      [{ userId: 1, createdAt: -1 }],
      [{ userId: 1, readAt: 1 }],
      [{ orderId: 1, createdAt: -1 }],
    ],
  },
);

export interface IDevice {
  _id: string;
  userId: string;
  token: string;
  platform: 'ios' | 'android' | 'web';
  deviceId?: string;
  appVersion?: string;
  lastSeenAt: Date;
}

export const DeviceModel = defineModel<IDevice>(
  'Device',
  {
    _id: pk('dev'),
    userId: { type: String, required: true, index: true },
    token: { type: String, required: true, unique: true },
    platform: { type: String, enum: ['ios', 'android', 'web'], required: true },
    deviceId: String,
    appVersion: String,
    lastSeenAt: { type: Date, default: Date.now },
  },
);

export interface INotificationPrefs {
  _id: string; // userId
  push: boolean;
  email: boolean;
  sms: boolean;
  whatsapp: boolean;
  kinds: Record<string, boolean>;
}

export const NotificationPrefsModel = defineModel<INotificationPrefs>('NotificationPrefs', {
  _id: { type: String },
  push: { type: Boolean, default: true },
  email: { type: Boolean, default: true },
  sms: { type: Boolean, default: false },
  whatsapp: { type: Boolean, default: true },
  kinds: { type: Object, default: {} },
});
