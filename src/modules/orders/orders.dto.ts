import { createSignedUrl } from '../../common/storage/signed-url.js';
import { displayMoney, mobileMoney, webMoney } from '../../common/utils/currency.js';
import { now } from '../../common/utils/clock.js';
import { mobileQuantity, webQuantity } from '../../common/utils/quantity.js';
import { unitPriceMinorPerGram } from '../../common/utils/pricing-math.js';
import { iso, watDisplay, watWindowDisplay } from '../../common/utils/time-display.js';
import type { IQuote } from '../../models/cart.model.js';
import type { IOrder } from '../../models/order.model.js';
import { MOBILE_BUY_LABEL, MOBILE_BUY_STATUS, STAGE_COUNT, stagesFor } from './order.stages.js';

/* ───────────────────────────── shared helpers ───────────────────────────── */

const bytesMeta = (kind: string, bytes?: number, issuedAt?: Date) => {
  const size = bytes ? (bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`) : '—';
  return `${kind === 'application/pdf' || !kind ? 'PDF' : kind} · ${size}${issuedAt ? ` · issued ${watDisplay(issuedAt).split(' · ')[0]}` : ''}`;
};

/** Catalog totals stay off the wire until the desk confirms the price agreed with the customer. */
function agreedTotal(o: IOrder) {
  return o.priceConfirmed ? o.total : null;
}

function stageProgress(o: IOrder): number {
  if (o.status === 'completed') return 100;
  return Math.round(((o.stageIndex + 1) / STAGE_COUNT) * 100);
}

/* ───────────────────────────── mobile ───────────────────────────── */

function mobileStatus(o: IOrder): { status: string; label: string; tone: 'live' | 'warn' | 'done' | 'gold' } {
  if (o.status === 'rejected') return { status: 'rejected', label: 'REJECTED', tone: 'warn' };
  if (o.status === 'cancelled') return { status: 'cancelled', label: 'CANCELLED', tone: 'warn' };
  const i = o.stageIndex;
  const tone = i === 0 ? 'warn' : i === 1 ? 'gold' : i === 5 ? 'done' : 'live';
  return { status: MOBILE_BUY_STATUS[i] ?? 'verifying', label: MOBILE_BUY_LABEL[i] ?? 'IN PROGRESS', tone };
}

const NEXT_STEPS = [
  { n: 1, title: 'Verification desk review', sub: 'Assay and origin documents re-checked. Within 24 hours.' },
  { n: 2, title: 'Verified quote issued', sub: 'Final weight, price and transport cost sent for approval.' },
  { n: 3, title: 'Payment and release', sub: 'Escrow funded, then bonded transport is booked.' },
];

export function toMobileOrderCreated(o: IOrder) {
  const s = mobileStatus(o);
  const first = o.lines[0];
  return {
    id: o._id,
    reference: o.reference,
    status: s.status,
    statusLabel: s.label,
    product: { id: first?.productId ?? null, name: first?.name ?? 'Order', imageUrl: first?.imageUrl ?? null },
    quantity: mobileQuantity(o.totalGrams),
    indicativeTotal: agreedTotal(o) ? mobileMoney(agreedTotal(o)) : null,
    priceConfirmed: Boolean(o.priceConfirmed),
    paymentTaken: o.paymentTaken,
    nextSteps: NEXT_STEPS.map((st, idx) => ({ ...st, state: idx === 0 ? 'active' : 'pending' })),
    createdAt: o.createdAt.toISOString(),
  };
}

export function toMobileOrderListItem(o: IOrder) {
  const s = mobileStatus(o);
  const first = o.lines[0];
  return {
    id: o._id,
    reference: o.reference,
    product: { name: first?.name ?? 'Order', imageUrl: first?.imageUrl ?? null },
    quantity: mobileQuantity(o.totalGrams),
    value: agreedTotal(o) ? mobileMoney(agreedTotal(o), { compact: true }) : null,
    priceConfirmed: Boolean(o.priceConfirmed),
    status: s.status,
    statusLabel: s.label,
    tone: s.tone,
    stage: { current: o.stageIndex + 1, total: STAGE_COUNT, label: `Step ${o.stageIndex + 1} of ${STAGE_COUNT}` },
    progress: stageProgress(o),
    eta: o.eta ? { from: o.eta.from.toISOString(), to: o.eta.to.toISOString(), display: watWindowDisplay(o.eta.from, o.eta.to) } : null,
  };
}

export function toMobileOrderDetail(o: IOrder) {
  const s = mobileStatus(o);
  const first = o.lines[0];
  return {
    id: o._id,
    reference: o.reference,
    status: s.status,
    statusLabel: s.label,
    tone: s.tone,
    product: { id: first?.productId ?? null, name: first?.name ?? 'Order', imageUrl: first?.imageUrl ?? null },
    quantity: mobileQuantity(o.totalGrams),
    escrow: {
      funded: o.settlement.status === 'held' || o.settlement.status === 'released',
      amount: agreedTotal(o) ? mobileMoney(agreedTotal(o)) : null,
      fundedAt: iso(o.settlement.fundedAt),
      releasedAt: iso(o.settlement.releasedAt),
    },
    assay: o.assay
      ? { finalWeight: mobileQuantity(o.assay.finalGrams), purity: o.assay.purity ?? null, certifiedAt: iso(o.assay.certifiedAt) }
      : null,
    seal: o.seal ? { reference: o.seal.reference, photographedAt: iso(o.seal.photographedAt) } : null,
    carrier: o.carrier ?? null,
    eta: o.eta ? { from: o.eta.from.toISOString(), to: o.eta.to.toISOString(), display: watWindowDisplay(o.eta.from, o.eta.to) } : null,
    canConfirmDelivery: o.status === 'active' && o.stageIndex === 4,
    version: o.version,
  };
}

export function toMobileTracking(o: IOrder) {
  const defs = stagesFor(o.side);
  const steps = defs.map((d, i) => {
    const hist = [...o.stageHistory].reverse().find((h) => h.index === i);
    const done = o.status === 'completed' ? true : i < o.stageIndex;
    const active = !done && i === o.stageIndex && o.status !== 'rejected' && o.status !== 'cancelled';
    return {
      key: d.key,
      title: d.title,
      sub: d.subtitle,
      at: iso(hist?.at),
      display: hist ? watDisplay(hist.at) : active ? 'Now' : 'Pending',
      state: done ? 'done' : active ? 'active' : 'pending',
    };
  });
  return {
    route: o.route
      ? {
          from: o.route.from,
          to: o.route.to,
          progress: o.route.progress,
          position: o.route.lat !== undefined && o.route.lng !== undefined ? { lat: o.route.lat, lng: o.route.lng } : null,
          updatedAt: iso(o.route.updatedAt),
        }
      : null,
    steps,
  };
}

export function toMobileOrderDocuments(o: IOrder) {
  return {
    data: o.documents.map((d) => {
      const ready = o.stageIndex >= d.availableFromStage;
      const signed = ready ? createSignedUrl('order-doc', `${o._id}:${d._id}`, 900) : null;
      return {
        id: d._id,
        name: d.name,
        kind: d.kind,
        contentType: d.contentType ?? 'application/pdf',
        bytes: d.bytes ?? null,
        issuedAt: iso(d.issuedAt),
        meta: ready ? bytesMeta(d.contentType ?? '', d.bytes, d.issuedAt) : 'Not available yet',
        ready,
        downloadUrl: signed?.url ?? null,
        expiresIn: signed?.expiresIn ?? null,
      };
    }),
  };
}

/* ───────────────────────────── web ───────────────────────────── */

const WEB_STATUS_LABEL: Record<IOrder['status'], { status: 'in_review' | 'active' | 'complete' | 'rejected' | 'cancelled'; label: string }> = {
  pending_review: { status: 'in_review', label: 'In review' },
  active: { status: 'active', label: 'Active' },
  completed: { status: 'complete', label: 'Complete' },
  rejected: { status: 'rejected', label: 'Rejected' },
  cancelled: { status: 'cancelled', label: 'Cancelled' },
};

export function toWebOrder(o: IOrder) {
  const defs = stagesFor(o.side);
  const idx = o.status === 'rejected' && o.rejection ? o.rejection.stageIndex : o.stageIndex;
  const stage = defs[Math.min(idx, defs.length - 1)]!;
  const first = o.lines[0];
  const st = WEB_STATUS_LABEL[o.status];
  return {
    id: o._id,
    reference: o.reference,
    side: o.side === 'buy' ? 'BUY' : 'SELL',
    lot: {
      id: first?.productId ?? o.source.refId ?? '',
      name: first?.name ?? 'Order',
      imageUrl: first?.imageUrl ?? null,
      gradientFrom: '#1f2937',
      gradientTo: '#92400e',
    },
    quantity: webQuantity(o.totalGrams),
    value: agreedTotal(o) ? webMoney(agreedTotal(o)) : null,
    priceDisplay: agreedTotal(o) ? displayMoney(agreedTotal(o)!) : null,
    priceConfirmed: Boolean(o.priceConfirmed),
    placedAt: o.createdAt.toISOString(),
    status: st.status,
    statusLabel: st.label,
    stage: { index: idx, total: STAGE_COUNT, title: stage.title, subtitle: stage.subtitle },
    progressPercent: o.status === 'rejected' ? Math.round((idx / STAGE_COUNT) * 100) : stageProgress(o),
    rejected: o.status === 'rejected',
    rejectionReason: o.rejection?.reason ?? null,
    region: o.region ?? null,
    closed: o.status === 'rejected' || o.status === 'completed' || o.status === 'cancelled',
  };
}

export function toWebOrderDetail(o: IOrder) {
  return {
    order: toWebOrder(o),
    settlement: {
      method: o.settlement.method,
      status: o.settlement.status,
      escrowReference: o.settlement.escrowReference ?? null,
      releasedAt: iso(o.settlement.releasedAt),
    },
    counterparty: o.counterparty ?? null,
    cancellable: (o.status === 'pending_review' || o.status === 'active') && o.settlement.status === 'not_funded' && o.stageIndex < 2,
    documentsAvailable: o.documents.filter((d) => o.stageIndex >= d.availableFromStage).length,
  };
}

export function toWebTimeline(o: IOrder) {
  const defs = stagesFor(o.side);
  const terminated = o.status === 'rejected';
  const cur = terminated ? (o.rejection?.stageIndex ?? o.stageIndex) : o.stageIndex;
  return {
    pipeline: o.side === 'buy' ? 'BUY' : 'SELL',
    currentIndex: cur,
    terminated,
    stages: defs.map((d, i) => {
      const hist = [...o.stageHistory].reverse().find((h) => h.index === i);
      const state = terminated
        ? i < cur
          ? 'done'
          : i === cur
            ? 'terminated'
            : 'pending'
        : o.status === 'completed' || i < cur
          ? 'done'
          : i === cur
            ? 'current'
            : 'pending';
      return {
        index: i,
        title: d.title,
        subtitle: d.subtitle,
        state,
        occurredAt: iso(hist?.at),
        note: state === 'terminated' ? (o.rejection?.reason ?? null) : null,
      };
    }),
  };
}

const LEGS = {
  buy: ['MB vault', 'Inspection hub', 'In transit', 'Your facility'],
  sell: ['Your site', 'Agent collection', 'Assay lab', 'MB vault'],
};

export function toWebLogistics(o: IOrder) {
  const labels = LEGS[o.side];
  const done = o.status === 'completed' ? 4 : Math.max(0, Math.min(4, o.stageIndex - 1));
  return {
    currentIndex: Math.min(done, 3),
    legs: labels.map((label, i) => ({
      index: i,
      label,
      meta: i === 2 && o.carrier ? o.carrier.name : '',
      state: i < done ? 'done' : 'pending',
      occurredAt: i < done ? iso(o.stageHistory[i + 1]?.at ?? o.stageHistory.at(-1)?.at) : null,
    })),
  };
}

export function toWebOrderDocuments(o: IOrder) {
  return {
    items: o.documents.map((d) => {
      const available = o.stageIndex >= d.availableFromStage;
      const signed = available ? createSignedUrl('order-doc', `${o._id}:${d._id}`, 300) : null;
      return {
        id: d._id,
        name: d.name,
        kind: d.kind,
        available,
        availableFromStage: d.availableFromStage,
        unavailableReason: available ? null : 'Available at a later stage',
        file: signed
          ? {
              id: d._id,
              name: `${d.name}.pdf`,
              mimeType: d.contentType ?? 'application/pdf',
              sizeBytes: d.bytes ?? 0,
              url: signed.url,
              expiresAt: signed.expiresAt.toISOString(),
              uploadedAt: (d.issuedAt ?? o.updatedAt).toISOString(),
            }
          : null,
      };
    }),
  };
}

export function toWebDownload(o: IOrder, docId: string) {
  const d = o.documents.find((x) => x._id === docId)!;
  const signed = createSignedUrl('order-doc', `${o._id}:${d._id}`, 300);
  return { url: signed.url, expiresAt: signed.expiresAt.toISOString(), name: `${d.name}.pdf`, sizeBytes: d.bytes ?? 0 };
}

export function toWebQuote(q: IQuote, extra: { availableGrams: number; withinAvailable: boolean; minOrderGrams: number; meetsMinimum: boolean; feeBps: number; unit?: 'g' | 'kg' | 't' | 'MT' | 'oz' | 'ct' }) {
  return {
    subtotal: webMoney(q.subtotal),
    platformFee: webMoney(q.platformFee),
    platformFeeRate: extra.feeBps / 10_000,
    paymentSurcharge: q.surcharge.amountMinor > 0 ? webMoney(q.surcharge) : null,
    total: webMoney(q.total),
    availableQuantity: webQuantity(extra.availableGrams, extra.unit),
    withinAvailable: extra.withinAvailable,
    minOrder: webQuantity(extra.minOrderGrams, extra.unit),
    meetsMinimum: extra.meetsMinimum,
    quoteId: q._id,
    expiresAt: q.expiresAt.toISOString(),
  };
}

export function toWebOrderCreated(o: IOrder) {
  const kind = o.paymentMethod === 'lc' ? 'open_contract' : o.settlement.status === 'not_funded' && o.stageIndex >= 1 ? 'fund_escrow' : 'await_verification';
  return { order: toWebOrder(o), nextAction: { kind, url: null as string | null } };
}

export function toMobileRequirementPrice(p: { grams: number; unitPriceMinorE4PerGram: number; indicativeTotal: { amountMinor: number; currency: string }; rateAsOf: Date }) {
  return {
    quantity: mobileQuantity(p.grams),
    unitPrice: mobileMoney({ amountMinor: unitPriceMinorPerGram(p.unitPriceMinorE4PerGram), currency: p.indicativeTotal.currency }),
    per: 'g',
    indicativeTotal: mobileMoney(p.indicativeTotal),
    rateAsOf: p.rateAsOf.toISOString(),
    note: 'No payment is taken now. A verified quote with final assay weight arrives within 48 hours.',
  };
}

export const nowIso = () => now().toISOString();
