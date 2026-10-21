import { z } from 'zod';
import { normalizeEmail, normalizePhone } from '../../common/utils/phone.js';

const method = z.enum(['mobile', 'email', 'whatsapp']);
const challengeId = z.string().min(4).max(64);

export const webRegisterBody = z
  .object({
    method,
    mobile: z.string().max(32).optional(),
    email: z.string().max(254).optional(),
    fullName: z.string().trim().min(2, 'Enter your full name').max(160),
    role: z.enum(['buyer', 'seller', 'both']),
    companyName: z.string().trim().max(160).optional(),
    country: z
      .string()
      .length(2, 'Use a two-letter country code')
      .transform((v) => v.toUpperCase()),
    acceptedTermsVersion: z.string().min(1).max(32),
  })
  .superRefine((v, ctx) => {
    if (v.method === 'email') {
      if (!v.email || !normalizeEmail(v.email)) {
        ctx.addIssue({ code: 'custom', path: ['email'], message: 'Enter a valid email address' });
      }
      if (v.mobile && !normalizePhone(v.mobile)) {
        ctx.addIssue({ code: 'custom', path: ['mobile'], message: 'Enter a valid mobile number with country code' });
      }
    } else if (!v.mobile || !normalizePhone(v.mobile)) {
      ctx.addIssue({ code: 'custom', path: ['mobile'], message: 'Enter a valid mobile number with country code' });
    }
    if (v.method !== 'email' && v.email && !normalizeEmail(v.email)) {
      ctx.addIssue({ code: 'custom', path: ['email'], message: 'Enter a valid email address' });
    }
  });

export const webOtpRequestBody = z
  .object({
    method,
    identifier: z.string().min(3).max(254),
    intent: z.enum(['login', 'signup']),
  })
  .superRefine((v, ctx) => {
    const ok = v.method === 'email' ? Boolean(normalizeEmail(v.identifier)) : Boolean(normalizePhone(v.identifier));
    if (!ok) {
      ctx.addIssue({
        code: 'custom',
        path: ['identifier'],
        message: v.method === 'email' ? 'Enter a valid email address' : 'Enter a valid mobile number with country code',
      });
    }
  });

/** Production web codes stay 4 digits. Development OTP challenges are 6 digits. */
export const webOtpVerifyBody = z.object({
  challengeId,
  code: z.string().regex(/^\d{4}$|^\d{6}$/, 'Enter the verification code'),
  /** Absent or true keeps the existing persistent refresh cookie. */
  rememberDevice: z.boolean().optional(),
});

/** W-7: the contract has no schema for resend; mirror mobile. */
export const webOtpResendBody = z.object({ challengeId });

export const webPasswordChangeBody = z.object({
  // Optional because OTP-only accounts have no password yet (W-6); the service enforces it when one exists.
  currentPassword: z.string().max(128).optional(),
  newPassword: z.string().max(128),
});

export const webDeleteAccountBody = z.object({
  confirmation: z.literal('DELETE', { errorMap: () => ({ message: 'Type DELETE to confirm' }) }),
  reason: z.string().max(500).optional(),
});

export const webSessionIdParams = z.object({ sessionId: z.string().min(4).max(64) });

export type WebRegisterBody = z.infer<typeof webRegisterBody>;
export type WebOtpRequestBody = z.infer<typeof webOtpRequestBody>;
