import { notFound } from '../../../common/errors/app-error.js';
import { Dispute, User } from '../../../models/people.models.js';
import { Order } from '../../../models/trading.models.js';
import { MS_DAY, ORDER_STAGES, ORDER_STAGE_LABEL, type OrderStage } from '../shared/enums.js';
import { oneOf, searchFilter, iso } from '../shared/http.js';
import { outMoney, outQty, outUnitPrice } from '../shared/money.js';
import { loadPartnerMap, loadStaffMap, loadUserMap, partyFrom, staffFrom } from '../shared/refs.js';

/** A catalog or quote total is not a price. Money is visible after the desk confirms it, or after payment has already moved. */
export function orderPriceVisible(o: object): boolean {
  const row = o as { priceConfirmedAt?: unknown; paymentStatus?: unknown };
  return Boolean(row.priceConfirmedAt) || row.paymentStatus === 'released';
}

/** Orders whose stored value may be summed into GMV, lifetime value, and sold-volume figures. */
export const CONFIRMED_ORDER_PRICE: Record<string, unknown> = {
  $or: [{ priceConfirmedAt: { $type: 'date' } }, { paymentStatus: 'released' }],
};

function publishedPrice(o: { value?: unknown; lockedRate?: unknown; priceConfirmedAt?: Date | null; paymentStatus?: string | null }) {
  if (!orderPriceVisible(o)) return { value: null, lockedRate: null, priceConfirmed: false as const };
  return { value: outMoney(o.value as never), lockedRate: outUnitPrice(o.lockedRate as never), priceConfirmed: true as const };
}

export const STAGE_DESCRIPTION: Record<OrderStage, string> = {
  verification: 'KYC, counterparty and consignment details checked',
  pricing_confirmation: 'Rate locked and firm offer confirmed',
  agent_visit: 'Field agent visits site, weighs and seals the sample',
  inspection_approval: 'Assay and inspection approved by the desk',
  payment_released: 'Payment released from escrow',
  custody_transfer: 'Custody moved into the Mineral Bridge vault',
};

export const stageIndex = (s: string): number => ORDER_STAGES.indexOf(s as OrderStage);

/** Whole days in the current stage, excluding time paused by hold_order exceptions. */
export function daysInStage(o: { stageEnteredAt?: Date; stagePausedMs?: number; exceptions?: Array<{ severity: string; status: string; holdStartedAt?: Date }> }, now = Date.now()): number {
  if (!o.stageEnteredAt) return 0;
  const activeHold = (o.exceptions ?? [])
    .filter((e) => e.severity === 'hold_order' && e.status === 'open' && e.holdStartedAt)
    .reduce((sum, e) => sum + (now - new Date(e.holdStartedAt!).getTime()), 0);
  const ms = Math.max(0, now - new Date(o.stageEnteredAt).getTime() - (o.stagePausedMs ?? 0) - activeHold);
  return Math.floor(ms / MS_DAY);
}

export const ORDER_SORT: Record<string, string> = {
  id: 'orderId',
  mineral: 'mineral.name',
  side: 'side',
  party: 'counterpartyId',
  quantity: 'quantity.value',
  stage: 'stage',
  daysInStage: 'stageEnteredAt',
  agent: 'agentId',
};

/** Shared by #23 (list) and #24 (export). `noStage` is the filter used for the chip counts. */
export async function buildOrderFilter(query: Record<string, unknown>): Promise<{ filter: Record<string, unknown>; noStage: Record<string, unknown> }> {
  const side = oneOf(query.side, ['buy', 'sell'] as const, 'side');
  const stage = oneOf(query.stage, ORDER_STAGES, 'stage');
  const status = oneOf(query.status, ['draft', 'active'] as const, 'status');
  const base: Record<string, unknown> = { status: status ?? { $in: ['active', 'completed'] } };
  if (side) base.side = side;

  const q = typeof query.q === 'string' ? query.q.trim() : '';
  if (q) {
    const s = searchFilter(q, ['orderId', 'mineral.name', 'grade', 'side', 'stage'])!;
    const users = await User.find({ $or: [{ name: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }, { org: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }] }, { userId: 1 }).limit(200).lean();
    const or = [...(s.$or as unknown[]), ...(users.length ? [{ counterpartyId: { $in: users.map((u) => u.userId) } }] : [])];
    base.$or = or;
  }
  const filter = stage ? { ...base, stage } : base;
  return { filter, noStage: base };
}

export async function mapOrderSummaries(docs: any[]) {  
  const [users, staff] = await Promise.all([loadUserMap(docs.map((d) => d.counterpartyId)), loadStaffMap(docs.map((d) => d.agentId))]);
  return docs.map((o) => ({
    id: o.orderId,
    side: o.side,
    mineral: o.mineral?.name,
    party: partyFrom(users, o.counterpartyId),
    quantity: outQty(o.quantity),
    stage: o.stage,
    daysInStage: daysInStage(o),
    agent: staffFrom(staff, o.agentId),
    openedAt: iso(o.openedAt),
    status: o.status,
    customerStatus: o.customerStatus || o.status,
    ...publishedPrice(o),
    priceEditable: o.status === 'active' && o.paymentStatus !== 'released' && o.stage !== 'payment_released' && o.stage !== 'custody_transfer',
    settlementMethod: o.settlementMethod || '',
    mineralForm: o.mineralForm || '',
    location: o.origin || '',
    verificationStatus: o.verificationStatus || '',
    photoCount: (o.documents ?? []).filter((d: { fileId?: string }) => d.fileId).length,
  }));
}

const KYC_FROM_STATUS: Record<string, string> = { verified: 'verified', in_review: 'in_review', expiring: 'expiring', rejected: 'rejected', suspended: 'rejected' };

export async function mapOrderDetail(o: any) {  
  const idx = stageIndex(o.stage);
  const partnerIds = [o.carrierId, o.hubId, o.labId];
  const histActors = (o.history ?? []).map((h: { actorId?: string }) => h.actorId);
  const [users, staff, partners, completed, disputes] = await Promise.all([
    loadUserMap([o.counterpartyId]),
    loadStaffMap([o.agentId, o.createdBy, ...(o.stageLog ?? []).map((l: { agentId?: string }) => l.agentId), ...histActors]),
    loadPartnerMap(partnerIds),
    Order.countDocuments({ counterpartyId: o.counterpartyId, stage: 'custody_transfer' }),
    Dispute.countDocuments({ partyId: o.counterpartyId }),
  ]);
  const cp = await User.findOne({ userId: o.counterpartyId }).lean();
  const summary = (await mapOrderSummaries([o]))[0]!;
  const log = new Map<string, { at?: Date; agentId?: string }>((o.stageLog ?? []).map((l: { stage: string }) => [l.stage, l]));
  const tracker = ORDER_STAGES.map((stage, i) => {
    const entry = log.get(stage);
    return {
      stage,
      state: i < idx ? 'done' : i === idx ? 'current' : 'upcoming',
      description: STAGE_DESCRIPTION[stage],
      at: iso(entry?.at),
      ...(i > idx ? { projectedAt: new Date(new Date(o.stageEnteredAt).getTime() + (i - idx) * 2 * MS_DAY).toISOString() } : {}),
      agent: staffFrom(staff, entry?.agentId ?? (i === idx ? o.agentId : undefined)),
    };
  });
  const stops = (o.route?.stops ?? []) as Array<{ kind: string; name: string; place: string; note: string }>;
  const doneUpTo = Math.floor((idx / 5) * stops.length);
  const partner = (id?: string) => (id ? partners.get(id) ?? null : null);
  return {
    ...summary,
    status: o.status,
    stageIndex: idx,
    tracker,
    route: {
      direction: o.route?.direction ?? (o.side === 'sell' ? 'seller_to_vault' : 'vault_to_buyer'),
      eta: iso(o.route?.eta),
      summary: o.route?.summary ?? '',
      stops: stops.map((s, k) => ({ kind: s.kind, name: s.name, place: s.place, state: k < doneUpTo ? 'done' : k === doneUpTo ? 'current' : 'upcoming', note: s.note ?? '' })),
    },
    facts: {
      value: publishedPrice(o).value,
      lockedRate: publishedPrice(o).lockedRate,
      priceConfirmed: publishedPrice(o).priceConfirmed,
      assayStatus: o.assayStatus,
      paymentStatus: o.paymentStatus,
      ...(o.releasedAmount ? { releasedAmount: outMoney(o.releasedAmount) } : {}),
      ...(o.sealNo ? { sealNo: o.sealNo } : {}),
      carrier: partner(o.carrierId),
      hub: partner(o.hubId),
      lab: partner(o.labId),
      ...(o.escrowRef ? { escrowRef: o.escrowRef } : {}),
      origin: o.origin ?? '',
      destination: o.destination ?? '',
      settlementMethod: o.settlementMethod || '',
      mineralForm: o.mineralForm || '',
      verificationStatus: o.verificationStatus || '',
      customerStatus: o.customerStatus || o.status || '',
    },
    documents: (o.documents ?? []).map((d: { id: string; name: string; ref: string; status: string; fileId?: string }) => ({ id: d.id, name: d.name, ref: d.ref, status: d.status, ...(d.fileId ? { fileId: d.fileId } : {}) })),
    history: [...(o.history ?? [])]
      .sort((a: { at: Date }, b: { at: Date }) => +new Date(b.at) - +new Date(a.at))
      .map((h: { text: string; actorId?: string; at: Date }) => ({ text: h.text, actor: staffFrom(staff, h.actorId), at: iso(h.at) })),
    counterparty: {
      party: partyFrom(users, o.counterpartyId),
      contactName: cp?.contactName ?? cp?.name ?? '',
      email: cp?.email ?? '',
      phone: cp?.phone ?? '',
      completedOrders: completed,
      disputes,
      kycStatus: cp && ['none', 'pending', 'verified', 'rejected'].includes(cp.kycStatus)
        ? cp.kycStatus
        : (KYC_FROM_STATUS[cp?.status ?? 'in_review'] ?? 'in_review'),
    },
    exceptions: (o.exceptions ?? []).map((e: { id: string; type: string; severity: string; openedAt: Date; status: string; description?: string }) => ({
      id: e.id,
      type: e.type,
      severity: e.severity,
      description: e.description,
      openedAt: iso(e.openedAt),
      status: e.status,
    })),
    linkedLcId: o.linkedLcId ?? null,
  };
}

export async function requireOrder(orderId: string) {
  const o = await Order.findOne({ orderId }).lean();
  if (!o) throw notFound('resource/not-found', `Order ${orderId} not found`);
  return o;
}

export { ORDER_STAGE_LABEL };
