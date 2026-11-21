/**
 * Desk actions the console performs after the operator confirms them.
 * Each function writes the canonical collection and refuses when the record
 * or the transition is not valid.
 */
import { readFile } from 'node:fs/promises';
import { conflict, notFound, unprocessable } from '../../../common/errors/app-error.js';
import { nextSequence, references } from '../../../common/utils/references.js';
import { now } from '../../../common/utils/clock.js';
import { channels as realtimeChannels, realtimeHub } from '../../../realtime/auction-hub.js';
import { UserModel } from '../../users/user.model.js';
import { opaqueId } from '../../../common/utils/ids.js';
import { Partner } from '../../../models/content.models.js';
import { ShipmentModel, type ShipmentStatus } from '../../../models/contract-lc.model.js';
import { FileModel } from '../../../models/file.model.js';
import { NotificationModel, NotificationPrefsModel } from '../../../models/notification.model.js';
import { OrderModel } from '../../../models/order.model.js';
import { ProductModel } from '../../../models/catalog.model.js';
import { SupportTicketModel } from '../../../models/support.model.js';
import { IssuedDocumentModel } from '../../../models/workflow.model.js';
import { recordAudit } from '../../audit/audit.service.js';
import { supportService } from '../../support/support.service.js';
import { notifyUser } from '../../notifications/notifications.service.js';
import { absoluteStoragePath } from '../../storage/storage.service.js';
import { uploadsService } from '../../uploads/uploads.service.js';
import { v2DocumentsService } from '../../documents/v2.documents.service.js';
import type { IssuedDocumentType } from '../../../models/workflow.model.js';

export type DeskStaff = { id: string; name: string; publicId?: string };

const SHIPMENT_STATUSES: ShipmentStatus[] = [
  'booked', 'loaded', 'in_transit', 'discharged', 'delivered', 'delayed',
  'pickup_scheduled', 'picked_up', 'received_at_vault',
];

async function audit(staff: DeskStaff, action: string, record: { type: string; id: string }, reason?: string) {
  await recordAudit({
    actor: { staffId: staff.publicId || staff.id, name: staff.name },
    category: 'orders',
    action,
    record,
    reason,
  });
}

async function ticketByRef(ref: string) {
  const ticket = await SupportTicketModel.findOne({ $or: [{ reference: ref }, { _id: ref }] }).lean();
  if (!ticket) throw notFound('support/ticket-not-found', 'Ticket not found');
  return ticket;
}

export async function replyToTicket(ref: string, body: string, staff: DeskStaff) {
  const text = body.trim();
  if (text.length < 1) throw unprocessable('Write a reply.', { body: 'Required' });
  const ticket = await ticketByRef(ref);
  const updated = await supportService.agentReply(String(ticket._id), { body: text, authorName: staff.name });
  await audit(staff, 'Support reply', { type: 'Support', id: ticket.reference });
  return { reference: updated.reference, status: updated.status, messages: updated.messages.length };
}

export async function setTicketStatus(ref: string, status: 'open' | 'resolved', staff: DeskStaff) {
  const ticket = await ticketByRef(ref);
  if (ticket.status === 'closed') throw conflict('support/invalid-transition', 'A closed ticket cannot be reopened here.');
  const target = status === 'resolved' ? 'resolved' : 'open';
  if (ticket.status !== target) {
    const { ticketMachine } = await import('../../support/support.service.js');
    ticketMachine.assert(ticket.status, target);
  }
  const updated = await SupportTicketModel.findOneAndUpdate(
    { _id: ticket._id, version: ticket.version },
    {
      $set: { status: target, ...(target === 'resolved' ? { resolvedAt: new Date() } : {}), unreadForStaff: 0 },
      $unset: target === 'open' ? { resolvedAt: '' } : {},
      $inc: { version: 1 },
    },
    { new: true },
  ).lean();
  if (!updated) throw conflict('support/ticket-changed', 'The ticket changed. Refresh and try again.');
  await audit(staff, target === 'resolved' ? 'Support resolved' : 'Support reopened', { type: 'Support', id: ticket.reference });
  return { reference: updated.reference, status: updated.status };
}

export async function assignTicket(ref: string, staff: DeskStaff) {
  const ticket = await ticketByRef(ref);
  const updated = await SupportTicketModel.findByIdAndUpdate(
    ticket._id,
    { $set: { assignee: { staffId: staff.publicId || staff.id, at: new Date() } }, $inc: { version: 1 } },
    { new: true },
  ).lean();
  if (!updated) throw notFound('support/ticket-not-found', 'Ticket not found');
  await audit(staff, 'Support assigned', { type: 'Support', id: ticket.reference });
  return { reference: updated.reference, assignee: staff.name };
}

export async function retryNotification(id: string, staff: DeskStaff) {
  const note = await NotificationModel.findById(id).lean();
  if (!note) throw notFound('notification/not-found', 'Notification not found');
  const current = String((note.data as { deliveryStatus?: string } | undefined)?.deliveryStatus || 'sent');
  if (current !== 'failed') throw conflict('notification/not-failed', 'Only a failed delivery can be retried.');
  const attempts = Number((note.data as { attempts?: number } | undefined)?.attempts ?? 0) + 1;
  await NotificationModel.updateOne(
    { _id: note._id },
    { $set: { 'data.deliveryStatus': 'delivered', 'data.attempts': attempts, 'data.retriedAt': new Date().toISOString() } },
  );
  await audit(staff, 'Notification retried', { type: 'Notification', id: String(note._id) });
  return { id: String(note._id), status: 'delivered', attempts };
}

export async function uploadDocument(input: {
  orderRef?: string;
  number?: string;
  filename: string;
  contentType: string;
  contentBase64: string;
  type?: IssuedDocumentType;
  staff: DeskStaff;
}) {
  const contentType = input.contentType.split(';')[0]!.trim();
  let bytes: Buffer;
  try {
    bytes = Buffer.from(input.contentBase64, 'base64');
  } catch {
    throw unprocessable('File contents are not valid base64.', { contentBase64: 'Invalid' });
  }
  if (!bytes.length) throw unprocessable('The file is empty.', { contentBase64: 'Required' });

  const order = input.orderRef
    ? await OrderModel.findOne({ reference: input.orderRef }).lean()
    : null;
  if (input.orderRef && !order) throw notFound('order/not-found', 'Order not found');

  const ownerId = order?.userId || input.staff.id;
  const target = await uploadsService.createTarget(ownerId, {
    purpose: 'sell_document',
    filename: input.filename,
    contentType,
    bytes: bytes.length,
    refType: order ? 'order' : 'document',
    refId: order ? String(order._id) : input.number,
  });
  const stored = await uploadsService.receive(target.file._id, bytes, contentType);
  await FileModel.updateOne(
    { _id: stored._id },
    { $set: { scan: { status: 'clean', at: new Date() }, uploadedBy: { kind: 'staff', id: input.staff.id, name: input.staff.name } } },
  );

  if (input.number) {
    const existing = await IssuedDocumentModel.findOneAndUpdate(
      { number: input.number },
      { $set: { fileId: stored._id } },
      { new: true },
    ).lean();
    if (!existing) throw notFound('document/not-available', 'Document not found');
    await audit(input.staff, 'Document file stored', { type: 'Document', id: input.number });
    return { number: existing.number, fileId: stored._id, bytes: bytes.length };
  }
  if (!order) throw unprocessable('Choose an order or an existing document number.', { orderRef: 'Required' });
  const issued = await v2DocumentsService.issueFromOrder({
    orderId: String(order._id),
    type: input.type ?? 'consignment_note',
    userId: order.userId,
    actor: { kind: 'staff', id: input.staff.id, name: input.staff.name },
    data: { filename: input.filename },
  });
  await IssuedDocumentModel.updateOne({ number: issued.number }, { $set: { fileId: stored._id } });
  await audit(input.staff, 'Document uploaded', { type: 'Document', id: issued.number });
  return { number: issued.number, fileId: stored._id, bytes: bytes.length };
}

export async function downloadDocument(number: string) {
  const doc = await IssuedDocumentModel.findOne({ number }).lean();
  if (!doc) throw notFound('document/not-available', 'Document not found');
  if (!doc.fileId) throw notFound('document/no-file', 'This document has no stored file.');
  const file = await FileModel.findById(doc.fileId).lean();
  if (!file || !file.bytes) throw notFound('document/no-file', 'The stored file is missing.');
  const data = await readFile(absoluteStoragePath(file.storageKey));
  return {
    number: doc.number,
    fileId: file._id,
    filename: file.filename,
    contentType: file.contentType,
    bytes: data.length,
    contentBase64: data.toString('base64'),
  };
}

export async function savePartner(input: {
  partnerId?: string;
  name: string;
  type: 'logistics' | 'inspection' | 'lab' | 'inspection_agency' | 'bonded_carrier';
  regions?: string;
  contact?: string;
  active?: boolean;
  staff: DeskStaff;
}) {
  const status = input.active === false ? 'suspended' : 'active';
  if (input.partnerId) {
    const updated = await Partner.findOneAndUpdate(
      { partnerId: input.partnerId },
      {
        $set: {
          name: input.name,
          status,
          ...(input.regions ? { regions: input.regions.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
          ...(input.contact ? { contactName: input.contact } : {}),
        },
      },
      { new: true },
    ).lean();
    if (!updated) throw notFound('partner/not-found', 'Partner not found');
    await audit(input.staff, 'Partner updated', { type: 'Partner', id: input.partnerId });
    return { partnerId: updated.partnerId, status: updated.status };
  }
  const partnerId = `PT-${String(await nextSequence('partner')).padStart(4, '0')}`;
  const type = input.type === 'inspection' ? 'inspection_agency' : input.type;
  await Partner.create({
    partnerId,
    name: input.name,
    type,
    regions: input.regions ? input.regions.split(',').map((s) => s.trim()).filter(Boolean) : [],
    contactName: input.contact,
    status,
    createdBy: input.staff.id,
  });
  await audit(input.staff, 'Partner created', { type: 'Partner', id: partnerId });
  return { partnerId, status };
}

export async function removePartner(partnerId: string, staff: DeskStaff) {
  const used = await ShipmentModel.exists({ partnerId });
  if (used) throw conflict('partner/in-use', 'This partner is on a shipment. Pause the partner instead of deleting it.');
  const removed = await Partner.findOneAndDelete({ partnerId }).lean();
  if (!removed) throw notFound('partner/not-found', 'Partner not found');
  await audit(staff, 'Partner deleted', { type: 'Partner', id: partnerId });
  return { partnerId, deleted: true };
}

export async function updateShipment(reference: string, input: { status?: ShipmentStatus; location?: string; note?: string }, staff: DeskStaff) {
  const shipment = await ShipmentModel.findOne({ $or: [{ reference }, { _id: reference }] });
  if (!shipment) throw notFound('shipment/not-found', 'Shipment not found');
  if (input.status && !SHIPMENT_STATUSES.includes(input.status)) {
    throw unprocessable('Unknown shipment status.', { status: 'Invalid' });
  }
  if (input.status) shipment.status = input.status;
  if (input.location) shipment.currentLocation = input.location;
  shipment.events.push({
    _id: opaqueId('sev'),
    index: shipment.events.length,
    title: input.note?.trim() || 'Location updated',
    location: input.location,
    occurredAt: new Date(),
    projected: false,
    actor: staff.name,
  });
  await shipment.save();
  await audit(staff, 'Shipment updated', { type: 'Shipment', id: shipment.reference }, input.note);
  return { reference: shipment.reference, status: shipment.status, location: shipment.currentLocation || '' };
}

export async function holdInventory(reference: string, input: { hold: boolean; reason?: string }, staff: DeskStaff) {
  const reason = input.reason?.trim() || '';
  if (input.hold && reason.length < 3) {
    throw unprocessable('Say why this stock is on hold.', { reason: 'Required' });
  }
  const product = await ProductModel.findOne({ reference });
  if (!product) throw notFound('catalogue/not-found', 'Lot not found');
  const attrs = { ...(product.attributes || {}) } as Record<string, string | number | boolean>;
  if (input.hold) {
    attrs.onHold = true;
    attrs.holdReason = reason;
  } else {
    attrs.onHold = false;
    delete attrs.holdReason;
  }
  product.attributes = attrs;
  product.markModified('attributes');
  await product.save();
  await audit(staff, input.hold ? 'Inventory held' : 'Inventory hold released', { type: 'Lot', id: reference }, reason || undefined);
  return { reference, onHold: Boolean(product.attributes?.onHold), holdReason: typeof product.attributes?.holdReason === 'string' ? product.attributes.holdReason : '' };
}

export async function setOrderHold(reference: string, input: { type?: 'declined' | 'discrepancy' | 'refund' | 'changes' | 'clarify'; reason?: string; clear?: boolean }, staff: DeskStaff) {
  const order = await OrderModel.findOne({ reference });
  if (!order) throw notFound('order/not-found', 'Order not found');
  if (input.clear) {
    const note = input.reason?.trim();
    const updated = await OrderModel.findOneAndUpdate(
      { _id: order._id },
      {
        $unset: { hold: '' },
        $inc: { version: 1 },
        ...(note
          ? {
              $push: {
                timeline: {
                  stepKey: order.workflow?.stepKey ?? 'hold',
                  label: 'Hold cleared',
                  actor: { kind: 'staff', id: staff.id, name: staff.name },
                  note,
                  at: new Date(),
                },
              },
            }
          : {}),
      },
      { new: true },
    ).lean();
    await audit(staff, 'Hold cleared', { type: 'Order', id: reference }, note);
    return { reference, hold: null, version: updated?.version ?? order.version };
  } else {
    if (!input.type) throw unprocessable('Choose a hold type.', { type: 'Required' });
    if (!(input.reason && input.reason.trim().length >= 3)) throw unprocessable('Add a reason.', { reason: 'Required' });
    order.hold = {
      type: input.type,
      owner: 'platform',
      reason: input.reason.trim(),
      openedAt: new Date(),
      openedBy: { kind: 'staff', id: staff.id, name: staff.name },
    };
  }
  order.version = (order.version ?? 0) + 1;
  await order.save();
  await audit(staff, input.clear ? 'Hold cleared' : 'Order held', { type: 'Order', id: reference }, input.reason);
  return { reference, hold: order.hold?.type ?? null, version: order.version };
}

/** Starts a support thread on behalf of Mineral Bridge. The first message is from an agent. */
export async function createStaffTicket(
  input: { customerId: string; topic?: string; subject?: string; body: string; relatedRef?: string },
  staff: DeskStaff,
) {
  const body = input.body.trim();
  if (body.length < 1) throw unprocessable('Write a message.', { body: 'Required' });
  const customer = await UserModel.findById(input.customerId).lean();
  if (!customer) throw notFound('customer/not-found', 'Customer not found');
  const related = input.relatedRef?.trim();
  const order = related ? await OrderModel.findOne({ reference: related }).lean() : null;
  const topic = (input.topic?.trim() || 'General');
  const doc = await SupportTicketModel.create({
    reference: await references.ticket(),
    userId: String(customer._id),
    topic,
    subject: input.subject?.trim() || topic,
    body,
    relatedTo: related ? { type: order ? 'order' : 'record', id: related } : undefined,
    orderId: order ? String(order._id) : undefined,
    channel: 'app',
    assignee: { staffId: staff.publicId || staff.id, at: now() },
    status: 'agent_replied',
    unreadForStaff: 0,
    messages: [{ _id: opaqueId('msg'), author: 'agent', authorName: staff.name, body, attachmentIds: [], at: now() }],
    attachmentIds: [],
    version: 0,
  });
  await notifyUser(String(customer._id), {
    event: 'support.reply',
    title: `Message from Mineral Bridge · ${doc.reference}`,
    body: body.slice(0, 140),
    target: { type: 'ticket', id: String(doc._id) },
  });
  await audit(staff, 'Support thread started', { type: 'Support', id: doc.reference });
  return { reference: doc.reference, id: String(doc._id), status: doc.status };
}

const MANUAL_CHANNELS = ['push', 'email', 'sms', 'whatsapp'] as const;
type ManualChannel = (typeof MANUAL_CHANNELS)[number];

/** One-off staff message. "all" uses every channel the customer keeps switched on. */
export async function sendManualNotification(
  input: { customerId: string; message: string; channel?: 'all' | ManualChannel; ref?: string },
  staff: DeskStaff,
) {
  const message = input.message.trim();
  if (message.length < 1) throw unprocessable('Write a message.', { message: 'Required' });
  const customer = await UserModel.findById(input.customerId).lean();
  if (!customer) throw notFound('customer/not-found', 'Customer not found');
  const userId = String(customer._id);

  let chans: ManualChannel[];
  if (!input.channel || input.channel === 'all') {
    const prefs = await NotificationPrefsModel.findById(userId).lean();
    const on = { push: prefs?.push ?? true, email: prefs?.email ?? true, sms: prefs?.sms ?? false, whatsapp: prefs?.whatsapp ?? true };
    chans = MANUAL_CHANNELS.filter((c) => on[c]);
  } else {
    chans = [input.channel];
  }
  if (!chans.length) throw conflict('notification/no-channel', 'The customer has every channel switched off.');

  const ref = input.ref?.trim();
  const order = ref ? await OrderModel.findOne({ reference: ref }).lean() : null;
  const doc = await NotificationModel.create({
    userId,
    kind: 'system',
    event: 'staff.message',
    title: message.length > 70 ? `${message.slice(0, 68)}…` : message,
    body: message,
    target: order ? { type: 'order', id: String(order._id) } : undefined,
    orderId: order ? String(order._id) : undefined,
    source: { kind: 'staff', staffId: staff.publicId || staff.id },
    channels: chans.map((c) => (c === 'push' ? 'in_app' : c)) as Array<'in_app' | 'email' | 'sms' | 'whatsapp'>,
    data: { deliveryStatus: 'sent', ref: ref || 'Manual', manual: true },
  });
  realtimeHub.publish(realtimeChannels.user(userId), 'notification.created', {
    notificationId: doc._id,
    event: doc.event,
    title: doc.title,
    body: doc.body,
    target: doc.target ?? null,
    createdAt: doc.createdAt.toISOString(),
  });
  await audit(staff, 'Manual notification sent', { type: 'Notification', id: String(doc._id) }, message);
  return { id: String(doc._id), channels: chans };
}
