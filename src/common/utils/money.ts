/** Customer APIs (mobile/web): integer minor units. Admin API: decimal major units. */

export type CustomerMoney = {
  amount: number;
  currency: string;
  scale?: number;
  display?: string;
};

export type AdminMoney = {
  amount: number;
  currency: string;
};

export type StoredMoney = {
  /** Always stored as integer minor units internally */
  amountMinor: number;
  currency: string;
  scale: number;
};

export function toStored(amountMinor: number, currency: string, scale = 2): StoredMoney {
  if (!Number.isInteger(amountMinor)) {
    throw new Error('Money amountMinor must be an integer');
  }
  return { amountMinor, currency, scale };
}

export function fromAdminMajor(major: number, currency: string, scale = 2): StoredMoney {
  const factor = 10 ** scale;
  const amountMinor = Math.round(major * factor);
  return { amountMinor, currency, scale };
}

export function toCustomerMoney(stored: StoredMoney, includeScale = false): CustomerMoney {
  const money: CustomerMoney = {
    amount: stored.amountMinor,
    currency: stored.currency,
  };
  if (includeScale) money.scale = stored.scale;
  return money;
}

export function toAdminMoney(stored: StoredMoney): AdminMoney {
  const factor = 10 ** stored.scale;
  return {
    amount: Number((stored.amountMinor / factor).toFixed(stored.scale)),
    currency: stored.currency,
  };
}

export function addMinor(a: number, b: number): number {
  return a + b;
}

export function percentOfMinor(amountMinor: number, basisPoints: number): number {
  // basisPoints: 100 = 1%
  return Math.round((amountMinor * basisPoints) / 10_000);
}
