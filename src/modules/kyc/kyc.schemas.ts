import { z } from 'zod';

// ---- mobile ---------------------------------------------------------------------------------

export const mobileDocumentFields = z.object({
  kind: z.enum(['id_front', 'id_back', 'selfie']),
  idTypeId: z.enum(['nin', 'passport', 'drivers_licence', 'voters_card']).optional(),
});

export const mobileSubmissionBody = z.object({
  idTypeId: z.enum(['nin', 'passport', 'drivers_licence', 'voters_card']),
  idNumber: z.string().min(4).max(32),
  documentIds: z.array(z.string().min(4).max(64)).min(1).max(6),
  tierId: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  declaredDetails: z
    .object({
      fullName: z.string().trim().min(2).max(160).optional(),
      dateOfBirth: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
        .optional(),
    })
    .optional(),
  // Not coerced: anything other than literal `true` must reach the service as `kyc/consent-required`.
  consent: z.boolean(),
});

export const submissionIdParams = z.object({ submissionId: z.string().min(4).max(64) });

// ---- web ------------------------------------------------------------------------------------

export const webPatchKycBody = z.object({
  idType: z.enum(['national', 'passport', 'licence']),
});

export const webCaptureBody = z.object({
  side: z.enum(['front', 'back', 'photo_page']),
  fileId: z.string().min(4).max(64),
});

export const webSideParams = z.object({ side: z.enum(['front', 'back', 'photo_page']) });

export const webSelfieBody = z.object({
  fileId: z.string().min(4).max(64),
  livenessToken: z.string().max(2048).optional(),
});
