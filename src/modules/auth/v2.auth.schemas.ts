import { z } from 'zod';

export const v2OtpChannelSchema = z.enum(['whatsapp', 'sms', 'email']);
export const v2OtpIntentSchema = z.enum(['signup', 'signin', 'contact_change']);

export const v2OtpRequestSchema = z
  .object({
    intent: v2OtpIntentSchema,
    channel: v2OtpChannelSchema,
    identifier: z.string().min(3).max(254),
    fullName: z.string().trim().min(2).max(160).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.intent === 'signup' && !val.fullName) {
      ctx.addIssue({ code: 'custom', path: ['fullName'], message: 'Required for signup' });
    }
  });

export const v2OtpResendSchema = z.object({
  challengeId: z.string().min(8).max(64),
  channel: v2OtpChannelSchema.optional(),
});

export const v2OtpVerifySchema = z.object({
  challengeId: z.string().min(8).max(64),
  code: z.string().regex(/^\d{4}$/),
  keepSignedIn: z.boolean().optional().default(true),
  device: z
    .object({
      id: z.string().max(128).optional(),
      name: z.string().max(120).optional(),
      platform: z.string().max(40).optional(),
    })
    .optional(),
});

export const v2BuyerTypeSchema = z.enum([
  'refinery',
  'house',
  'industry',
  'jewel',
  'investor',
  'wholesale',
]);
export const v2SellerTypeSchema = z.enum([
  'asm',
  'industrial',
  'coop',
  'dealer',
  'exporter',
  'form',
  'scrap',
]);
export const v2RoleSchema = z.enum(['buyer', 'seller', 'both']);

export const v2RegisterSchema = z
  .object({
    registrationToken: z.string().min(10),
    fullName: z.string().trim().min(2).max(160),
    role: v2RoleSchema,
    buyerType: v2BuyerTypeSchema.optional(),
    sellerType: v2SellerTypeSchema.optional(),
    businessName: z.string().trim().min(2).max(160).optional(),
    countryCode: z.string().regex(/^[A-Z]{2}$/),
    acceptTerms: z.literal(true),
    termsVersion: z.string().min(1).max(40),
  })
  .superRefine((val, ctx) => {
    if (val.role !== 'seller' && !val.buyerType) {
      ctx.addIssue({ code: 'custom', path: ['buyerType'], message: 'Required for buyer/both' });
    }
    if (val.role !== 'buyer' && !val.sellerType) {
      ctx.addIssue({ code: 'custom', path: ['sellerType'], message: 'Required for seller/both' });
    }
  });

export const v2RefreshSchema = z.object({
  refreshToken: z.string().min(10).optional(),
});

export const v2MePatchSchema = z
  .object({
    fullName: z.string().trim().min(2).max(160).optional(),
    businessName: z.string().trim().min(2).max(160).optional(),
    countryCode: z.string().regex(/^[A-Z]{2}$/).optional(),
  })
  .refine((v) => v.fullName !== undefined || v.businessName !== undefined || v.countryCode !== undefined, {
    message: 'At least one field required',
  });

export const v2ContactChangeSchema = z.object({
  channel: v2OtpChannelSchema,
  identifier: z.string().min(3).max(254),
});

export const v2ContactChangeVerifySchema = z.object({
  challengeId: z.string().min(8).max(64),
  code: z.string().regex(/^\d{4}$/),
});

export const v2BusinessTypeSchema = z
  .object({
    role: v2RoleSchema,
    buyerType: v2BuyerTypeSchema.optional(),
    sellerType: v2SellerTypeSchema.optional(),
    businessName: z.string().trim().min(2).max(160).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.role !== 'seller' && !val.buyerType) {
      ctx.addIssue({ code: 'custom', path: ['buyerType'], message: 'Required for buyer/both' });
    }
    if (val.role !== 'buyer' && !val.sellerType) {
      ctx.addIssue({ code: 'custom', path: ['sellerType'], message: 'Required for seller/both' });
    }
  });

export const v2NotificationPrefsSchema = z
  .object({
    email: z.boolean().optional(),
    sms: z.boolean().optional(),
    whatsapp: z.boolean().optional(),
    push: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'At least one key required' });

export type V2OtpRequestBody = z.infer<typeof v2OtpRequestSchema>;
export type V2OtpVerifyBody = z.infer<typeof v2OtpVerifySchema>;
export type V2RegisterBody = z.infer<typeof v2RegisterSchema>;
