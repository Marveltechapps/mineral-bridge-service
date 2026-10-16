import { z } from 'zod';

const qty = z.object({ value: z.number().positive(), unit: z.enum(['g', 'kg', 't']) });

export const itemIdParam = z.object({ itemId: z.string().min(1) });
export const addItemBody = z.object({ productId: z.string().min(1), quantity: qty });
export const patchItemBody = z.object({ quantity: qty, version: z.number().int().optional() });
export const quoteBody = z.object({}).passthrough().default({});
