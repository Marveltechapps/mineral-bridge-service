import { z } from 'zod';

export const idParam = z.object({ notificationId: z.string().min(1) });
export const tokenParam = z.object({ token: z.string().min(1) });

export const mobileListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
  unread: z.union([z.literal('true'), z.literal('false'), z.boolean()]).optional().transform((v) => v === true || v === 'true'),
});

export const webListQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  perPage: z.coerce.number().int().min(1).max(100).optional(),
  unreadOnly: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => v === true || v === 'true'),
  kind: z.string().optional(),
});

export const registerDeviceBody = z.object({
  token: z.string().min(8).max(4096),
  platform: z.enum(['ios', 'android', 'web']),
  deviceId: z.string().max(200).optional(),
  appVersion: z.string().max(40).optional(),
  locale: z.string().max(20).optional(),
});

export const preferencesBody = z.object({
  channels: z
    .object({ email: z.boolean().optional(), sms: z.boolean().optional(), push: z.boolean().optional() })
    .optional(),
  kinds: z.record(z.boolean()).optional(),
});
