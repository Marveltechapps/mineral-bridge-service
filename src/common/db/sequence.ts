import { Schema, type ClientSession } from 'mongoose';
import { defineModel } from './define-model.js';

const counterSchema = new Schema<any>({ _id: { type: String }, seq: { type: Number, default: 0 } }, { versionKey: false });
export const Counter = defineModel('Counter', counterSchema);

type Kind = { prefix: string; yearly?: boolean; pad: number; start: number };

/** Human-readable ids from API-CONTRACT §1. Sequences are atomic ($inc on a counter doc). */
export const ID_KINDS = {
  orderSell: { prefix: 'MB-SELL-', pad: 5, start: 41000 },
  orderBuy: { prefix: 'MB-BUY-', pad: 5, start: 38000 },
  lot: { prefix: 'MBV-', yearly: true, pad: 4, start: 400 },
  listing: { prefix: 'MBL-', yearly: true, pad: 4, start: 100 },
  auction: { prefix: 'AUC-', yearly: true, pad: 4, start: 200 },
  lc: { prefix: 'LC-', yearly: true, pad: 4, start: 400 },
  negotiation: { prefix: 'NEG-', yearly: true, pad: 4, start: 200 },
  contract: { prefix: 'CTR-', yearly: true, pad: 4, start: 180 },
  passport: { prefix: 'MBP-', yearly: true, pad: 4, start: 1200 },
  anchor: { prefix: 'ANC-', yearly: true, pad: 4, start: 900 },
  kyc: { prefix: 'KYC-', pad: 4, start: 7700 },
  dispute: { prefix: 'DSP-', yearly: true, pad: 4, start: 60 },
  ticket: { prefix: 'TKT-', pad: 4, start: 5500 },
  settlement: { prefix: 'STL-', yearly: true, pad: 4, start: 4400 },
  user: { prefix: 'USR-', pad: 5, start: 10400 },
  staff: { prefix: 'STF-', pad: 4, start: 1 },
  offer: { prefix: 'OFR-', pad: 5, start: 1000 },
  intake: { prefix: 'INT-', pad: 4, start: 100 },
  tierRequest: { prefix: 'TRQ-', pad: 4, start: 1 },
  course: { prefix: 'CRS-', pad: 4, start: 1 },
  lesson: { prefix: 'LSN-', pad: 4, start: 1 },
  banner: { prefix: 'BNR-', pad: 4, start: 1 },
  partner: { prefix: 'PTN-', pad: 4, start: 1 },
  notification: { prefix: 'NTF-', pad: 4, start: 9000 },
  file: { prefix: 'FILE-', pad: 6, start: 1 },
  audit: { prefix: 'AUD-', pad: 7, start: 1 },
  exception: { prefix: 'EXC-', pad: 5, start: 1 },
  message: { prefix: 'MSG-', pad: 6, start: 1 },
  docRequest: { prefix: 'DRQ-', pad: 5, start: 1 },
  exportJob: { prefix: 'EXP-', pad: 5, start: 1 },
  bid: { prefix: 'BID-', pad: 6, start: 1 },
  call: { prefix: 'CALL-', pad: 5, start: 1 },
  document: { prefix: 'DOC-', pad: 5, start: 1 },
  flag: { prefix: 'FLG-', pad: 5, start: 1 },
  amendment: { prefix: 'AMD-', pad: 5, start: 1 },
  discrepancy: { prefix: 'DSC-', pad: 5, start: 1 },
  ticketNote: { prefix: 'NOTE-', pad: 5, start: 1 },
  disputeMessage: { prefix: 'DMSG-', pad: 5, start: 1 },
  activity: { prefix: 'ACT-', pad: 6, start: 1 },
  session: { prefix: 'SES-', pad: 5, start: 1 },
  chainEvent: { prefix: 'EVT-', pad: 6, start: 1 },  role: { prefix: 'ROLE-', pad: 3, start: 1 },
} satisfies Record<string, Kind>;

export type IdKind = keyof typeof ID_KINDS;

export async function nextSeq(key: string, session?: ClientSession, attempt = 0): Promise<number> {
  try {
    const doc = await Counter.findOneAndUpdate(
      { _id: key },
      { $inc: { seq: 1 } },
      { upsert: true, new: true, session },
    ).lean<{ seq: number }>();
    return doc!.seq;
  } catch (err) {
    // Concurrent first upserts can race on the unique _id; retry once.
    if (attempt < 3 && (err as { code?: number }).code === 11000) return nextSeq(key, session, attempt + 1);
    throw err;
  }
}

export async function nextId(kind: IdKind, session?: ClientSession, now = new Date()): Promise<string> {
  const cfg = ID_KINDS[kind] as Kind;
  const year = now.getUTCFullYear();
  const key = cfg.yearly ? `${kind}:${year}` : kind;
  const seq = (await nextSeq(key, session)) + cfg.start - 1;
  const num = String(seq).padStart(cfg.pad, '0');
  return cfg.yearly ? `${cfg.prefix}${year}-${num}` : `${cfg.prefix}${num}`;
}
