import { conflict, notFound, unprocessable } from '../../common/errors/app-error.js';
import { idempotencyScope, runIdempotent } from '../../common/idempotency/idempotency.js';
import { now } from '../../common/utils/clock.js';
import { opaqueId } from '../../common/utils/ids.js';
import { references } from '../../common/utils/references.js';
import { StateMachine } from '../../common/utils/state-machine.js';
import { CallbackRequestModel, ChatSessionModel, SupportTicketModel } from '../../models/support.model.js';
import type { ICallbackRequest, IChatMessage, IChatSession, ISupportTicket, TicketStatus } from '../../models/support.model.js';
import { channels, realtimeHub } from '../../realtime/auction-hub.js';
import { notifyUser } from '../notifications/notifications.service.js';
import { uploadsService } from '../uploads/uploads.service.js';

export const ticketMachine = new StateMachine<TicketStatus>(
  'support-ticket',
  {
    open: ['agent_replied', 'escalated', 'resolved'],
    agent_replied: ['open', 'waiting_on_user', 'escalated', 'resolved'],
    waiting_on_user: ['open', 'escalated', 'resolved'],
    escalated: ['agent_replied', 'resolved'],
    resolved: ['open', 'closed'],
    closed: [],
  },
  'support/invalid-transition',
);

const REOPEN_WINDOW_MS = 7 * 86_400_000;

export const supportService = {
  /* -- tickets -- */
  async createTicket(input: { userId: string; topic: string; subject: string; body: string; relatedTo?: { type: string; id: string }; attachmentIds?: string[]; idempotencyKey?: string }) {
    const attachmentIds = input.attachmentIds ?? [];
    if (attachmentIds.length) await uploadsService.ownedMany(input.userId, attachmentIds);
    const make = async () => {
      const doc = await SupportTicketModel.create({
        reference: await references.ticket(),
        userId: input.userId,
        topic: input.topic,
        subject: input.subject,
        body: input.body,
        relatedTo: input.relatedTo,
        status: 'open',
        messages: [{ _id: opaqueId('msg'), author: 'user', body: input.body, attachmentIds, at: now() }],
        attachmentIds,
        version: 0,
      });
      return doc._id as string;
    };
    if (!input.idempotencyKey) return { id: await make(), replayed: false };
    const out = await runIdempotent<{ id: string }>({
      scope: idempotencyScope(input.userId, 'ticket:create'),
      key: input.idempotencyKey,
      body: { topic: input.topic, subject: input.subject, body: input.body, relatedTo: input.relatedTo, attachmentIds },
      successStatus: 201,
      fn: async () => ({ id: await make() }),
    });
    return { id: out.result.id, replayed: out.replayed };
  },

  async listTickets(userId: string, status: 'open' | 'resolved' | undefined, skip: number, limit: number) {
    const closed: TicketStatus[] = ['resolved', 'closed'];
    const filter = { userId, ...(status === 'resolved' ? { status: { $in: closed } } : status === 'open' ? { status: { $nin: closed } } : {}) };
    const [rows, total, open] = await Promise.all([
      SupportTicketModel.find(filter).sort({ updatedAt: -1, _id: -1 }).skip(skip).limit(limit).lean<ISupportTicket[]>(),
      SupportTicketModel.countDocuments(filter),
      SupportTicketModel.countDocuments({ userId, status: { $nin: closed } }),
    ]);
    return { rows, total, counts: { open } };
  },

  async getTicket(userId: string, id: string): Promise<ISupportTicket> {
    const t = await SupportTicketModel.findOne({ _id: id, userId }).lean<ISupportTicket>();
    if (!t) throw notFound('support/ticket-not-found', 'Ticket not found');
    return t;
  },

  async addUserMessage(userId: string, id: string, input: { body: string; attachmentIds?: string[] }) {
    const t = await this.getTicket(userId, id);
    if (t.status === 'closed') throw conflict('support/ticket-closed', 'This ticket is closed. Open a new ticket.');
    if (t.status === 'resolved' && t.resolvedAt && now().getTime() - t.resolvedAt.getTime() > REOPEN_WINDOW_MS) {
      throw conflict('support/ticket-closed', 'This ticket was resolved more than 7 days ago. Open a new ticket.');
    }
    const attachmentIds = input.attachmentIds ?? [];
    if (attachmentIds.length) await uploadsService.ownedMany(userId, attachmentIds);
    if (t.status !== 'open') ticketMachine.assert(t.status, 'open');
    const updated = await SupportTicketModel.findOneAndUpdate(
      { _id: id, userId, version: t.version },
      { $set: { status: 'open' }, $unset: { resolvedAt: '' }, $push: { messages: { _id: opaqueId('msg'), author: 'user', body: input.body, attachmentIds, at: now() } }, $inc: { version: 1 } },
      { new: true },
    ).lean<ISupportTicket>();
    if (!updated) throw conflict('support/ticket-changed', 'The ticket changed. Refresh and try again.');
    return updated;
  },

  async resolve(userId: string, id: string) {
    const t = await this.getTicket(userId, id);
    ticketMachine.assert(t.status, 'resolved');
    const updated = await SupportTicketModel.findOneAndUpdate(
      { _id: id, userId, version: t.version, status: t.status },
      { $set: { status: 'resolved', resolvedAt: now() }, $push: { messages: { _id: opaqueId('msg'), author: 'system', body: 'You marked this ticket as resolved.', attachmentIds: [], at: now() } }, $inc: { version: 1 } },
      { new: true },
    ).lean<ISupportTicket>();
    if (!updated) throw conflict('support/ticket-changed', 'The ticket changed. Refresh and try again.');
    return updated;
  },

  /** Agent side (admin console / jobs). */
  async agentReply(id: string, input: { body: string; authorName: string; status?: 'agent_replied' | 'waiting_on_user' | 'resolved' }) {
    const t = await SupportTicketModel.findById(id).lean<ISupportTicket>();
    if (!t) throw notFound('support/ticket-not-found', 'Ticket not found');
    const to = input.status ?? 'agent_replied';
    ticketMachine.assert(t.status, to);
    const updated = await SupportTicketModel.findOneAndUpdate(
      { _id: id, version: t.version },
      { $set: { status: to, ...(to === 'resolved' ? { resolvedAt: now() } : {}) }, $push: { messages: { _id: opaqueId('msg'), author: 'agent', authorName: input.authorName, body: input.body, attachmentIds: [], at: now() } }, $inc: { version: 1 } },
      { new: true },
    ).lean<ISupportTicket>();
    if (!updated) throw conflict('support/ticket-changed', 'The ticket changed concurrently.');
    await notifyUser(t.userId, { event: 'support.reply', title: `Reply on ${t.reference}`, body: input.body.slice(0, 140), target: { type: 'ticket', id } });
    return updated;
  },

  /* -- live chat -- */
  async startChat(userId: string, topic?: string): Promise<IChatSession> {
    const existing = await ChatSessionModel.findOne({ userId, status: { $in: ['waiting', 'active'] } }).lean<IChatSession>();
    if (existing) return existing;
    const doc = await ChatSessionModel.create({
      userId,
      status: 'waiting',
      topic,
      messages: [{ _id: opaqueId('cmg'), author: 'system', body: 'Connecting you to a Mineral Bridge specialist...', at: now() }],
    });
    return doc.toObject() as IChatSession;
  },

  async getChat(userId: string, id: string): Promise<IChatSession> {
    const s = await ChatSessionModel.findOne({ _id: id, userId }).lean<IChatSession>();
    if (!s) throw notFound('support/chat-not-found', 'Chat session not found');
    return s;
  },

  /** Idempotent per clientId so a retried send never duplicates the message. */
  async sendChat(userId: string, id: string, input: { body: string; clientId?: string }): Promise<{ session: IChatSession; message: IChatMessage }> {
    const s = await this.getChat(userId, id);
    if (s.status === 'ended') throw conflict('support/chat-ended', 'This chat has ended.');
    if (input.clientId) {
      const dup = s.messages.find((m) => m.clientId === input.clientId);
      if (dup) return { session: s, message: dup };
    }
    const message: IChatMessage = { _id: opaqueId('cmg'), clientId: input.clientId, author: 'user', body: input.body, at: now() };
    const updated = await ChatSessionModel.findOneAndUpdate(
      { _id: id, userId, status: { $ne: 'ended' }, ...(input.clientId ? { 'messages.clientId': { $ne: input.clientId } } : {}) },
      { $push: { messages: message } },
      { new: true },
    ).lean<IChatSession>();
    if (!updated) return this.sendChat(userId, id, input); // lost a dedupe race or the chat just ended: re-evaluate
    realtimeHub.publish(channels.chat(id), 'message.created', { sessionId: id, message: { id: message._id, clientId: message.clientId ?? null, author: 'user', body: message.body, at: message.at.toISOString() } });
    return { session: updated, message };
  },

  async endChat(userId: string, id: string) {
    const s = await this.getChat(userId, id);
    if (s.status === 'ended') return s;
    const updated = await ChatSessionModel.findOneAndUpdate({ _id: id, userId, status: { $ne: 'ended' } }, { $set: { status: 'ended', endedBy: 'user', endedAt: now() } }, { new: true }).lean<IChatSession>();
    realtimeHub.publish(channels.chat(id), 'session.ended', { sessionId: id, endedBy: 'user' });
    return updated ?? (await this.getChat(userId, id));
  },

  async agentChatMessage(id: string, agent: { id: string; name: string; initials: string }, body: string) {
    const message: IChatMessage = { _id: opaqueId('cmg'), author: 'agent', body, at: now() };
    const s = await ChatSessionModel.findOneAndUpdate({ _id: id, status: { $ne: 'ended' } }, { $set: { status: 'active', agent }, $push: { messages: message } }, { new: true }).lean<IChatSession>();
    if (!s) throw conflict('support/chat-ended', 'This chat has ended.');
    realtimeHub.publish(channels.chat(id), 'message.created', { sessionId: id, message: { id: message._id, clientId: null, author: 'agent', agent, body, at: message.at.toISOString() } });
    return s;
  },

  /* -- contact requests -- */
  async requestCallback(userId: string, input: { phone?: string; topic?: string; note?: string; preferredWindow?: string; relatedTo?: { type: string; id: string } }): Promise<ICallbackRequest> {
    const recent = await CallbackRequestModel.findOne({ userId, status: { $in: ['requested', 'scheduled'] } }).lean<ICallbackRequest>();
    if (recent) throw conflict('support/callback-pending', 'You already have a call-back request in progress.');
    if (!input.phone) throw unprocessable('A phone number is required', { phone: 'Required' });
    const doc = await CallbackRequestModel.create({ userId, status: 'requested', ...input });
    return doc.toObject() as ICallbackRequest;
  },
};

