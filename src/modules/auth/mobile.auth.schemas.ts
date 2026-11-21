import { z } from 'zod';

const deviceSchema = z
  .object({
    id: z.string().min(1).max(128).optional(),
    platform: z.enum(['android', 'ios']).optional(),
    name: z.string().max(120).optional(),
    pushToken: z.string().max(512).optional(),
  })
  .strict()
  .optional();

const challengeId = z.string().min(4).max(64);

/** `phone` is validated in the controller so the failure is `auth/invalid-phone`, not a generic 422. */
export const mobileOtpRequestBody = z.object({
  phone: z.string().min(1).max(32),
  intent: z.enum(['signup', 'login']),
  channel: z.enum(['sms', 'voice', 'whatsapp']).default('sms'),
});

export const mobileOtpVerifyBody = z.object({
  challengeId,
  phone: z.string().min(1).max(32),
  code: z.string().regex(/^\d{4}$/, 'Enter the 4-digit code'),
  device: deviceSchema,
});

export const mobileOtpResendBody = z.object({ challengeId });

export const mobileAlternateChannelBody = z.object({
  challengeId,
  channel: z.enum(['voice', 'whatsapp']),
});

export const mobileRefreshBody = z.object({
  refreshToken: z.string().min(16).max(256),
});

export const mobileSignOutBody = z
  .object({ allDevices: z.boolean().optional() })
  .default({});

export const mobilePinBody = z.object({
  currentPin: z.string().regex(/^\d{4}$/, 'Enter your current 4-digit PIN').optional(),
  newPin: z.string().regex(/^\d{4}$/, 'Enter a 4-digit PIN'),
});

export const sessionIdParams = z.object({ sessionId: z.string().min(4).max(64) });

export type MobileOtpRequestBody = z.infer<typeof mobileOtpRequestBody>;
export type MobileOtpVerifyBody = z.infer<typeof mobileOtpVerifyBody>;
