import { CounterModel } from '../../models/counter.model.js';

export async function nextSequence(key: string): Promise<number> {
  const doc = await CounterModel.findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { upsert: true, new: true }).lean();
  return doc?.seq ?? 1;
}

const pad = (n: number, w: number) => String(n).padStart(w, '0');

/** Human references (mobile contract §2.7). Never used as path parameters. */
export const references = {
  order: async () => `MB-${new Date().getUTCFullYear()}-${pad(await nextSequence('order') + 4870, 5)}`,
  sellRequest: async () => `MB-S-${pad((await nextSequence('sell-request')) + 90411, 5)}`,
  bulkQuote: async () => `MB-Q-${pad((await nextSequence('bulk-quote')) + 90417, 5)}`,
  auction: async () => `MB-A-${pad((await nextSequence('auction')) + 2213, 4)}`,
  seal: async () => `MB-SL-${pad((await nextSequence('seal')) + 4470, 4)}`,
  ticket: async () => `TCK-${pad((await nextSequence('ticket')) + 4470, 4)}`,
  listing: async () => `MB-L-${pad((await nextSequence('listing')) + 10000, 5)}`,
  contract: async () => `MB-C-${pad((await nextSequence('contract')) + 20000, 5)}`,
  lc: async () => `MB-LC-${pad((await nextSequence('lc')) + 30000, 5)}`,
  shipment: async () => `MB-SH-${pad((await nextSequence('shipment')) + 40000, 5)}`,
  negotiation: async () => `MB-N-${pad((await nextSequence('negotiation')) + 50000, 5)}`,
  asm: async () => `MB-ASM-${pad((await nextSequence('asm')) + 60000, 5)}`,
  withdrawal: async () => `MB-W-${pad((await nextSequence('withdrawal')) + 70000, 5)}`,
  certificate: async () => `MB-CERT-${pad((await nextSequence('certificate')) + 80000, 5)}`,
};
