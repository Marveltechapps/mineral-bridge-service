import type { IProduct } from '../../models/catalog.model.js';

/** True only for catalogue rows buyers must not order (status sold), not zero untracked stock. */
export function productSoldOut(p: Pick<IProduct, 'status'>): boolean {
  return p.status === 'sold';
}

/** Active lot with no tracked grams — orderable on request (see orders.service loadSellableProduct). */
export function productAvailableOnRequest(p: Pick<IProduct, 'status' | 'availableGrams'>): boolean {
  return p.status === 'active' && (p.availableGrams ?? 0) <= 0;
}

export function productInventoryTracked(p: Pick<IProduct, 'availableGrams'>): boolean {
  return (p.availableGrams ?? 0) > 0;
}

export function catalogueAvailabilityFlags(p: Pick<IProduct, 'status' | 'availableGrams'>) {
  const soldOut = productSoldOut(p);
  return {
    soldOut,
    availableOnRequest: !soldOut && productAvailableOnRequest(p),
    inventoryTracked: productInventoryTracked(p),
  };
}