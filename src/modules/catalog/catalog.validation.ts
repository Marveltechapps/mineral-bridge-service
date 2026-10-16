import { z } from 'zod';

export const productIdParam = z.object({ productId: z.string().min(1) });

const bool = z.union([z.literal('true'), z.literal('false'), z.boolean()]).optional().transform((v) => (v === undefined ? undefined : v === true || v === 'true'));

export const productListQuery = z.object({
  category: z.string().optional(),
  type: z.string().optional(),
  q: z.string().trim().max(100).optional(),
  assured: bool,
  minGrams: z.coerce.number().int().min(0).optional(),
  maxUnitPrice: z.coerce.number().int().min(0).optional(),
  sort: z.enum(['newest', 'price_asc', 'price_desc']).default('newest'),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

export const typesQuery = z.object({ category: z.string().optional() });
export const searchQuery = z.object({ q: z.string().trim().min(1).max(100), limit: z.coerce.number().int().min(1).max(50).optional() });

export const lotListQuery = z.object({
  category: z.string().optional(),
  mineral: z.string().optional(),
  country: z.string().optional(),
  q: z.string().trim().max(100).optional(),
  verified: bool,
  minGrams: z.coerce.number().int().min(0).optional(),
  sort: z.enum(['newest', 'price_asc', 'price_desc']).default('newest'),
  page: z.coerce.number().int().min(1).optional(),
  perPage: z.coerce.number().int().min(1).max(100).optional(),
});
