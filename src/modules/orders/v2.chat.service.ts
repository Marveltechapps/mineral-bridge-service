import { now } from '../../common/utils/clock.js';
import { opaqueId } from '../../common/utils/ids.js';
import { conflict } from '../../common/errors/app-error.js';
import { references } from '../../common/utils/references.js';
import { OrderModel, type IOrder } from '../../models/order.model.js';
import { SupportTicketModel, type ISupportTicket } from '../../models/support.model.js';
import { notifyUser } from '../notifications/notifications.service.js';
import { enqueueOutbox } from '../outbox/outbox.service.js';
import { uploadsService } from '../uploads/uploads.service.js';
import { loadOwnedOrder, loadOrderByRef } from './v2.order-helpers.js';

function msgDto(m: ISupportTicket['messages'][number]) {
  const readAt = (m as { readAt?: Date }).readAt;
  const authorRaw = m.author as unknown;
  // BUG-016: always expose structured sender fields for clients.
  const authorObj =
    typeof authorRaw === 'string'
      ? {
          kind: authorRaw === 'agent' ? 'agent' : 'user',
          sender_role: authorRaw === 'agent' ? 'agent' : 'customer',
          sender_name: (m as { agentName?: string }).agentName ?? (authorRaw === 'agent' ? 'Support' : 'You'),
        }
      : authorRaw && typeof authorRaw === 'object'
        ? authorRaw
        : { kind: 'user', sender_role: 'customer' };
  return {
    id: m._id,
    body: m.body,
    author: authorObj,
    sender_id: (authorObj as { id?: string }).id ?? null,
    sender_name: (authorObj as { sender_name?: string; name?: string }).sender_name
      ?? (authorObj as { name?: string }).name
      ?? null,
    sender_role: (authorObj as { sender_role?: string; kind?: string }).sender_role
      ?? (authorObj as { kind?: string }).kind
      ?? null,
    attachmentIds: m.attachmentIds ?? [],
    at: (m.at instanceof Date ? m.at : new Date(m.at)).toISOString(),
    readAt: readAt ? (readAt instanceof Date ? readAt : new Date(readAt)).toISOString() : null,
  };
}

async function ensureOrderThread(order: IOrder, userId: string): Promise<ISupportTicket> {
  if (order.links?.threadId) {
    const existing = await SupportTicketModel.findById(order.links.threadId).lean<ISupportTicket>();
    if (existing) return existing;
  }
  const byRelated = await SupportTicketModel.findOne({
    userId,
    'relatedTo.type': 'order',
    'relatedTo.id': order._id,
  }).lean<ISupportTicket>();
  if (byRelated) {
    await OrderModel.updateOne({ _id: order._id }, { $set: { 'links.threadId': byRelated._id } });
    return byRelated;
  }
  const created = await SupportTicketModel.create({
    reference: await references.ticket(),
    userId,
    topic: order.side === 'sell' ? 'sell' : 'order',
    subject: `Order ${order.reference}`,
    body: `Thread for order ${order.reference}`,
    relatedTo: { type: 'order', id: order._id },
    status: 'open',
    messages: [],
    attachmentIds: [],
    version: 0,
  });
  await OrderModel.updateOne({ _id: order._id }, { $set: { 'links.threadId': created._id } });
  return created.toObject() as ISupportTicket;
}

export const v2OrderChatService = {
  async list(userId: string, ref: string, skip = 0, limit = 50) {
    const order = await loadOwnedOrder(userId, ref);
    const thread = await ensureOrderThread(order, userId);
    const items = (thread.messages ?? []).slice().reverse().slice(skip, skip + limit).reverse();
    const suggestions: { label: string; action: string }[] = [];
    if (order.paymentTaken || order.settlement?.status === 'held') {
      suggestions.push({ label: 'Request a refund', action: 'refund.request' });
    }
    if (order.hold?.type === 'changes') {
      suggestions.push({ label: 'Submit requested changes', action: 'order.changes' });
    }
    return {
      items: items.map(msgDto),
      nextCursor: skip + items.length < (thread.messages?.length ?? 0) ? String(skip + items.length) : null,
      thread: thread.reference,
      suggestions,
    };
  },

  async post(userId: string, ref: string, body: string, attachmentFileIds?: string[]) {
    const order = await loadOwnedOrder(userId, ref);
    if (attachmentFileIds?.length) await uploadsService.ownedMany(userId, attachmentFileIds);
    const thread = await ensureOrderThread(order, userId);
    if (thread.status === 'closed') throw conflict('support/ticket-closed', 'This order thread is closed.');
    const message = {
      _id: opaqueId('msg'),
      author: 'user' as const,
      body,
      attachmentIds: attachmentFileIds ?? [],
      at: now(),
    };
    const updated = await SupportTicketModel.findOneAndUpdate(
      { _id: thread._id, version: thread.version },
      {
        $set: { status: 'open' },
        $unset: { resolvedAt: '' },
        $push: { messages: message },
        $inc: { version: 1 },
      },
      { new: true },
    ).lean<ISupportTicket>();
    if (!updated) throw conflict('support/ticket-changed', 'Thread changed; retry');
    await enqueueOutbox('notify.staff', {
      action: 'support',
      event: 'order.chat',
      orderRef: order.reference,
      threadRef: thread.reference,
    });
    return msgDto(message);
  },

  async adminPost(orderRef: string, staff: { id: string; name: string }, body: string) {
    const order = await loadOrderByRef(orderRef);
    const thread = await ensureOrderThread(order, order.userId);
    const message = {
      _id: opaqueId('msg'),
      author: 'agent' as const,
      body,
      attachmentIds: [] as string[],
      at: now(),
      agentName: staff.name,
    };
    await SupportTicketModel.updateOne(
      { _id: thread._id },
      { $set: { status: 'agent_replied' }, $push: { messages: message }, $inc: { version: 1 } },
    );
    await notifyUser(order.userId, {
      event: 'support.reply',
      title: `Reply on ${order.reference}`,
      body: body.slice(0, 120),
      target: { type: 'order', id: order._id },
    });
    return msgDto(message);
  },
};
