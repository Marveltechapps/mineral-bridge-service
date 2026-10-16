import { customAlphabet } from 'nanoid';

const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const nano = customAlphabet(alphabet, 16);

export function opaqueId(prefix: string): string {
  return `${prefix}_${nano()}`;
}

export function businessRef(prefix: string, year = new Date().getUTCFullYear()): string {
  const seq = nano().slice(0, 5).toUpperCase();
  return `${prefix}-${year}-${seq}`;
}

export const IdPrefixes = {
  user: 'usr',
  staff: 'stf',
  session: 'ses',
  otp: 'otp',
  order: 'ord',
  listing: 'lst',
  sellRequest: 'srq',
  bulkQuote: 'bqk',
  auction: 'auc',
  bid: 'bid',
  lot: 'lot',
  product: 'prd',
  cartItem: 'cit',
  negotiation: 'neg',
  offer: 'off',
  contract: 'ctr',
  lc: 'lc',
  shipment: 'shp',
  document: 'doc',
  file: 'fil',
  notification: 'ntf',
  ticket: 'tkt',
  chat: 'cht',
  payout: 'pay',
  payoutAccount: 'pac',
  kyc: 'kyc',
  address: 'adr',
  passport: 'psp',
  asm: 'asm',
  course: 'crs',
  lesson: 'lsn',
  dispute: 'dsp',
  audit: 'aud',
  partner: 'ptr',
  banner: 'bnr',
  settlement: 'stl',
  idempotency: 'idm',
  rate: 'rte',
  vaultLot: 'vlt',
} as const;
