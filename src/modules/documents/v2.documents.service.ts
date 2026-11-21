import { now } from '../../common/utils/clock.js';
import { forbidden, notFound } from '../../common/errors/app-error.js';
import { references } from '../../common/utils/references.js';
import { OrderModel, type IOrder } from '../../models/order.model.js';
import {
  IssuedDocumentModel,
  type IIssuedDocument,
  type IssuedDocumentType,
} from '../../models/workflow.model.js';
import type { ActorRef } from '../../models/schema-primitives.js';

const TYPE_PREFIX: Partial<Record<IssuedDocumentType, string>> = {
  quotation: 'QT',
  e_contract: 'CT',
  sell_e_contract: 'SCT',
  auction_terms: 'AT',
  auction_result: 'AR',
  payment_receipt: 'PR',
  tax_invoice: 'TI',
  inspection_report: 'IR',
  test_certificate: 'TC',
  payment_advice: 'PA',
  consignment_note: 'CN',
  proof_of_delivery: 'POD',
  completion_certificate: 'CC',
  refund_receipt: 'RR',
  cancellation_confirmation: 'CX',
};

function summary(doc: IIssuedDocument) {
  return {
    number: doc.number,
    type: doc.type,
    version: doc.version,
    status: doc.status,
    issuedAt: doc.issuedAt.toISOString(),
    entity: doc.entity,
  };
}

function renderData(doc: IIssuedDocument, order?: IOrder | null) {
  return {
    title: doc.type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    number: doc.number,
    version: doc.version,
    status: doc.status,
    issuedAt: doc.issuedAt.toISOString(),
    parties: {
      customerNo: order?.customerNo,
      orderRef: order?.reference,
      userId: doc.userId,
    },
    sections: [
      {
        heading: 'Summary',
        rows: [
          { label: 'Document type', value: doc.type },
          { label: 'Order', value: order?.reference ?? doc.entity.id },
          { label: 'Amount', value: order?.pricing?.lockedTotal ?? order?.total },
          { label: 'Status', value: order?.status },
        ],
      },
      ...(doc.data ? [{ heading: 'Details', rows: Object.entries(doc.data).map(([k, v]) => ({ label: k, value: v })) }] : []),
    ],
    data: doc.data ?? {},
  };
}

/** Minimal valid PDF without external libs — embeds the JSON render as text. */
export function renderPdfBuffer(payload: Record<string, unknown>): Buffer {
  const text = JSON.stringify(payload, null, 2)
    .replace(/[()\\]/g, (c) => `\\${c}`)
    .slice(0, 3500);
  const stream = `BT /F1 10 Tf 40 750 Td (${text.replace(/\n/g, ') Tj T* (')}) Tj ET`;
  const objects = [
    '1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n',
    '2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n',
    '3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj\n',
    `4 0 obj<< /Length ${Buffer.byteLength(stream)} >>stream\n${stream}\nendstream\nendobj\n`,
    '5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += obj;
  }
  const xrefStart = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf);
}

export const v2DocumentsService = {
  async listForOrder(userId: string, orderRef: string) {
    const order =
      (await OrderModel.findOne({ reference: orderRef, userId }).lean<IOrder>()) ??
      (await OrderModel.findOne({ _id: orderRef, userId }).lean<IOrder>());
    if (!order) throw notFound('order/not-found', 'Order not found');
    const rows = await IssuedDocumentModel.find({
      'entity.type': 'order',
      'entity.id': order._id,
      status: { $in: ['issued', 'processing', 'replaced'] },
    })
      .sort({ issuedAt: -1 })
      .lean<IIssuedDocument[]>();
    return { items: rows.map(summary) };
  },

  async getByNumber(input: { number: string; userId?: string; staff?: boolean; format?: 'json' | 'pdf' }) {
    const doc =
      (await IssuedDocumentModel.findOne({ number: input.number, status: { $in: ['issued', 'processing', 'replaced'] } })
        .sort({ version: -1 })
        .lean<IIssuedDocument>()) ??
      (await IssuedDocumentModel.findOne({ number: input.number }).sort({ version: -1 }).lean<IIssuedDocument>());
    if (!doc) throw notFound('document/not-available', 'Document not found');

    let order: IOrder | null = null;
    if (doc.entity.type === 'order') {
      order = await OrderModel.findById(doc.entity.id).lean<IOrder>();
    }
    if (!input.staff) {
      const ownerId = doc.userId ?? order?.userId;
      if (!input.userId || !ownerId || ownerId !== input.userId) {
        // public lot docs allowed when entity.type === 'product'
        if (doc.entity.type !== 'product') throw forbidden('auth/forbidden', 'Not your document');
      }
    }

    const payload = renderData(doc, order);
    if (input.format === 'pdf') {
      return { kind: 'pdf' as const, buffer: renderPdfBuffer(payload), filename: `${doc.number}.pdf` };
    }
    return { kind: 'json' as const, document: payload };
  },

  async issueFromOrder(input: {
    orderId: string;
    type: IssuedDocumentType;
    userId?: string;
    actor: ActorRef;
    data?: Record<string, unknown>;
  }) {
    const order = await OrderModel.findById(input.orderId).lean<IOrder>();
    if (!order) throw notFound('order/not-found', 'Order not found');
    const number = await references.document(TYPE_PREFIX[input.type] ?? 'DOC');
    const doc = await IssuedDocumentModel.create({
      number,
      type: input.type,
      entity: { type: 'order', id: order._id },
      userId: input.userId ?? order.userId,
      version: 1,
      status: 'issued',
      data: {
        orderRef: order.reference,
        total: order.pricing?.lockedTotal ?? order.total,
        ...input.data,
      },
      issuedBy: input.actor,
      issuedAt: now(),
    });
    return summary(doc.toObject() as IIssuedDocument);
  },

  async adminList(q: { status?: string; type?: string; search?: string }) {
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    if (q.type) filter.type = q.type;
    if (q.search) filter.number = new RegExp(q.search, 'i');
    const rows = await IssuedDocumentModel.find(filter).sort({ issuedAt: -1 }).limit(100).lean<IIssuedDocument[]>();
    return { items: rows.map(summary) };
  },

  async reissue(number: string, reason: string, actor: ActorRef) {
    const prev = await IssuedDocumentModel.findOne({ number, status: 'issued' }).lean<IIssuedDocument>();
    if (!prev) throw notFound('document/not-available', 'Issued document not found');
    const nextVersion = prev.version + 1;
    const flipped = await IssuedDocumentModel.updateOne(
      { _id: prev._id, status: 'issued' },
      { $set: { status: 'replaced', cancelReason: reason } },
    );
    if (!flipped.modifiedCount) throw notFound('document/not-available', 'Issued document not found');
    try {
      const created = await IssuedDocumentModel.create({
        number,
        type: prev.type,
        entity: prev.entity,
        userId: prev.userId,
        version: nextVersion,
        status: 'issued',
        fileId: prev.fileId,
        data: { ...(prev.data ?? {}), reissueReason: reason },
        issuedBy: actor,
        issuedAt: now(),
      });
      await IssuedDocumentModel.updateOne({ _id: prev._id }, { $set: { replacedBy: created._id } });
      return summary(created.toObject() as IIssuedDocument);
    } catch (err) {
      await IssuedDocumentModel.updateOne({ _id: prev._id }, { $set: { status: 'issued' }, $unset: { cancelReason: '' } });
      throw err;
    }
  },

  async cancel(number: string, reason: string, _actor: ActorRef) {
    const doc = await IssuedDocumentModel.findOne({ number, status: 'issued' });
    if (!doc) throw notFound('document/not-available', 'Issued document not found');
    doc.status = 'cancelled';
    doc.cancelReason = reason;
    await doc.save();
    return summary(doc.toObject() as IIssuedDocument);
  },
};
