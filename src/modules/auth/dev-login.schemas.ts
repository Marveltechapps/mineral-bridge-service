import { z } from 'zod';

/** Unknown fields such as `role` or `isAdmin` are discarded. The server chooses the audience. */
export const devLoginBody = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(254),
  password: z.string().min(1, 'Enter the developer password').max(256),
});

export const devLoginVerifyBody = z.object({
  challengeId: z.string().min(4).max(64),
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit development code'),
  rememberDevice: z.boolean().optional(),
});
