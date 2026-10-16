import { z } from 'zod';

const email = z
  .string({ required_error: 'Enter your work email.' })
  .trim()
  .toLowerCase()
  .email('Enter a valid work email.')
  .max(254);

export const adminSignInBody = z.object({
  email: z.string().trim().toLowerCase().min(1, 'Enter your work email and password.').max(254),
  password: z.string().min(1, 'Enter your work email and password.').max(256),
  returnTo: z.string().max(200).optional(),
});

export const adminSsoStartBody = z.object({
  email,
  returnTo: z.string().max(200).optional(),
});

export const adminSsoCallbackBody = z.object({
  code: z.string().min(1).max(4096),
  state: z.string().min(1).max(4096),
});

/** Admin codes are 6 digits. */
export const adminOtpVerifyBody = z.object({
  challengeId: z.string().min(4).max(64),
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

export const adminOtpResendBody = z.object({ challengeId: z.string().min(4).max(64) });

/** Signed-in callers (Profile) may send `{}`; the controller then uses the session's email. */
export const adminPasswordResetBody = z.object({ email: email.optional() }).default({});

export const adminPasswordResetConfirmBody = z.object({
  token: z.string().min(16).max(256),
  newPassword: z.string().max(128),
});

export const adminUnlockBody = z.object({ password: z.string().min(1, 'Enter your password.').max(256) });
