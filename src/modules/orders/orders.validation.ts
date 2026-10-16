import { z } from 'zod';

const mobileQty = z.object({ value: z.number().positive(), unit: z.enum(['g', 'kg', 't']) });
const webQty = z.object({ value: z.number().positive(), unit: z.enum(['g', 'kg', 'oz', 'ct', 'MT']) });
const paymentMethod = z.enum(['escrow', 'wire', 'lc', 'btc']);

export const orderIdParam = z.object({ orderId: z.string().min(1) });
export const orderDocParams = z.object({ orderId: z.string().min(1), documentId: z.string().min(1) });

const delivery = z.object({
  addressId: z.string().optional(),
  facilityName: z.string().max(200).optional(),
  streetAddress: z.string().max(300).optional(),
  city: z.string().max(100).optional(),
  region: z.string().max(100).optional(),
  country: z.string().length(2).optional(),
  contactPerson: z.string().max(120).optional(),
  contactPhone: z.string().max(30).optional(),
  importPermitNumber: z.string().max(60).optional(),
});

export const mobileCreateOrderBody = z
  .object({
    productId: z.string().nullish(),
    cartId: z.string().nullish(),
    quantity: mobileQty.nullish(),
    neededBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    delivery,
    acceptedTerms: z.literal(true, { errorMap: () => ({ message: 'Terms must be accepted' }) }),
  })
  .refine((b) => Boolean(b.cartId) !== Boolean(b.productId), {
    message: 'Provide either productId + quantity or cartId, not both',
    path: ['productId'],
  })
  .refine((b) => !b.productId || Boolean(b.quantity), { message: 'quantity is required with productId', path: ['quantity'] });

export const webCreateOrderBody = z.object({
  lotId: z.string().min(1),
  quantity: webQty,
  paymentMethod,
  quoteId: z.string().optional(),
  deliveryAddress: z
    .object({
      city: z.string().max(100),
      region: z.string().max(100).nullish(),
      country: z.string().length(2),
      countryName: z.string().max(100).optional(),
    })
    .optional(),
  payoutMethodId: z.string().optional(),
  notes: z.string().max(1000).optional(),
});

export const webQuoteBody = z.object({ lotId: z.string().min(1), quantity: webQty, paymentMethod });

export const mobilePriceBody = z.object({ productId: z.string().min(1), quantity: mobileQty, tierId: z.number().int().min(1).max(3).optional() });

export const mobileListQuery = z.object({
  tab: z.enum(['active', 'completed']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

export const webListQuery = z.object({
  side: z.enum(['buy', 'sell']).optional(),
  status: z.enum(['active', 'completed']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  perPage: z.coerce.number().int().min(1).max(100).optional(),
});

export const confirmDeliveryBody = z.object({
  sealIntact: z.boolean(),
  assayAccepted: z.boolean(),
  note: z.string().max(500).nullish(),
  version: z.number().int().optional(),
});

export const cancelBody = z.object({ reason: z.string().max(500).optional() }).default({});
