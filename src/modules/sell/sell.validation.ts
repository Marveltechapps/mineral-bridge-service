import { z } from 'zod';

const qty = z.object({ value: z.number().positive(), unit: z.enum(['g', 'kg', 't']) });

export const requestIdParam = z.object({ requestId: z.string().min(1) });
export const bulkIdParam = z.object({ bulkQuoteId: z.string().min(1) });
export const quoteIdParam = z.object({ quoteId: z.string().min(1) });

export const mediaBody = z.object({ filename: z.string().min(1).max(200), contentType: z.string().min(3).max(100), bytes: z.number().int().positive() });

export const estimateBody = z.object({ mineralTypeId: z.string().min(1), quantity: qty, photoIds: z.array(z.string()).max(8).optional() });

export const slotsQuery = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), days: z.coerce.number().int().min(1).max(14).default(7) });

export const createRequestBody = z.object({
  estimateId: z.string().optional(),
  mineralTypeId: z.string().min(1),
  quantity: qty,
  photoIds: z.array(z.string()).max(8).default([]),
  pickup: z.object({ addressId: z.string().optional(), label: z.string().max(120).optional(), display: z.string().max(300).optional() }),
  evaluation: z.object({ slotKey: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/) }),
  payoutAccountId: z.string().optional(),
});

export const listQuery = z.object({
  status: z.enum(['active', 'closed']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

export const acceptBody = z.object({ version: z.number().int().min(0), payoutAccountId: z.string().optional() });
export const declineBody = z.object({ version: z.number().int().min(0).optional(), reason: z.enum(['price_too_low', 'changed_mind', 'other']).optional(), note: z.string().max(500).optional() });
export const reviewBody = z.object({ version: z.number().int().min(0).optional(), note: z.string().max(500).optional() });

export const valuationBody = z.object({ mineralTypeId: z.string().min(1), quantity: qty, purityPct: z.number().min(1).max(100) });

export const bulkBody = z.object({
  mineralTypeId: z.string().min(1),
  quantity: qty,
  purityPct: z.number().min(1).max(100),
  photoIds: z.array(z.string()).max(12).default([]),
  offtakePartner: z.string().max(120).optional(),
  origin: z.object({ site: z.string().max(120).optional(), extractionDate: z.string().optional() }).optional(),
  description: z.string().max(1000).optional(),
  facility: z.record(z.string().max(200)).default({}),
  exportPermitNumber: z.string().min(3).max(60),
  proofOfAddressDocumentId: z.string().optional(),
});
