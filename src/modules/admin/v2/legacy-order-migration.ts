/**
 * Plans a copy from the old checkout `orders` collection into `cust_orders`.
 *
 * It never updates or deletes an existing v2 order, and it never deletes the
 * source row. A write is reversible by deleting only documents whose
 * `migration.batch` matches the batch that created them.
 *
 * `totalDue` on the old collection is a plain number beside `subtotal`. This
 * plan treats it as major currency units and stores the original number on
 * the migration marker so the assumption can be checked before a write.
 */
import { commercialUnit, gramsInUnit } from '../../../common/utils/quantity.js';

export type LegacyCheckoutOrder = {
  _id?: { toString(): string } | string;
  userId?: string;
  orderId?: string;
  mineralName?: string;
  mineralId?: string;
  quantity?: number;
  unit?: string;
  totalDue?: number;
  type?: string;
  status?: string;
  createdAt?: Date;
};

export type MigrationPlan =
  | { action: 'skip'; reference: string; reason: string }
  | { action: 'insert'; reference: string; document: Record<string, unknown> };

function gramsOf(quantity: number, unit: string): number | null {
  const parsed = commercialUnit(unit);
  if (!parsed) return null;
  const q = Number(quantity);
  if (!Number.isFinite(q) || q < 0) return null;
  return Math.round(q * gramsInUnit(parsed));
}

export function planLegacyCheckout(
  doc: LegacyCheckoutOrder,
  ctx: { existingRefs: Set<string>; userIds: Set<string>; batch: string },
): MigrationPlan {
  const reference = String(doc.orderId ?? '').trim();
  if (!reference) return { action: 'skip', reference: '', reason: 'missing orderId' };
  if (ctx.existingRefs.has(reference)) return { action: 'skip', reference, reason: 'reference already exists in cust_orders' };
  const userId = String(doc.userId ?? '');
  if (!userId || !ctx.userIds.has(userId)) return { action: 'skip', reference, reason: 'customer is not in users' };

  const statusWord = String(doc.status ?? '').toLowerCase();
  const cancelled = /cancel|reject/.test(statusWord);
  const completed = /complete|deliver|done/.test(statusWord);
  const side = /sell/.test(String(doc.type ?? '').toLowerCase()) ? 'sell' : 'buy';
  const stepKey = completed ? 'done' : side === 'sell' ? 'reviewed' : 'accepted';
  if (doc.totalDue == null || doc.totalDue === ('' as unknown)) {
    return { action: 'skip', reference, reason: 'missing totalDue' };
  }
  const totalDue = Number(doc.totalDue);
  if (!Number.isFinite(totalDue) || totalDue < 0) {
    return { action: 'skip', reference, reason: 'totalDue is not a major-unit amount' };
  }
  const unit = String(doc.unit || 'g');
  const grams = gramsOf(Number(doc.quantity ?? 0), unit);
  if (grams == null) return { action: 'skip', reference, reason: `unknown unit ${unit}` };
  const amountMinor = Math.round(totalDue * 100);
  const legacyId = typeof doc._id === 'string' ? doc._id : doc._id?.toString() ?? reference;

  return {
    action: 'insert',
    reference,
    document: {
      reference,
      userId,
      side,
      status: cancelled ? 'cancelled' : completed ? 'completed' : 'active',
      source: { kind: 'admin', refId: reference },
      workflow: {
        definition: side === 'sell' ? 'sell.v2' : 'buy.v2',
        stepKey,
        stepIndex: 0,
        owner: 'platform',
        enteredAt: doc.createdAt ?? new Date(),
      },
      lines: [{
        name: doc.mineralName || doc.mineralId || 'Imported lot',
        grams,
        unitPriceMinorE4PerGram: 0,
        lineTotalMinor: amountMinor,
      }],
      totalGrams: grams,
      subtotal: { amountMinor, currency: 'USD', scale: 2 },
      platformFee: { amountMinor: 0, currency: 'USD', scale: 2 },
      surcharge: { amountMinor: 0, currency: 'USD', scale: 2 },
      total: { amountMinor, currency: 'USD', scale: 2 },
      version: 0,
      migration: {
        source: 'legacy-orders',
        batch: ctx.batch,
        legacyId,
        totalDueOriginal: totalDue,
        reversible: true,
      },
    },
  };
}

export function hostedDatabase(uri: string): boolean {
  return /mongodb\.net|mongodb\+srv/i.test(uri);
}
