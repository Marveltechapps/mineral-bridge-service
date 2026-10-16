import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { currentUserId } from '../../common/http/actor.js';
import { ah } from '../../common/http/async-handler.js';
import { idempotencyKey } from '../../common/middleware/idempotency-key.js';
import { validate } from '../../common/middleware/validate.js';
import { buildCursorPage, buildOffsetPage, cursorWindow, pageWindow } from '../../common/utils/cursor.js';
import { agoDisplay, iso } from '../../common/utils/time-display.js';
import { now } from '../../common/utils/clock.js';
import type { IChatMessage, IChatSession, ISupportTicket } from '../../models/support.model.js';
import { requireUser } from '../auth/auth.middleware.js';
import { contentService } from '../content/content.service.js';
import { uploadsService } from '../uploads/uploads.service.js';
import { supportService as svc } from './support.service.js';

/* -- validation -------------------------------------------------------------------------- */

export const ticketIdParam = z.object({ ticketId: z.string().min(1) });
const sessionParam = z.object({ sessionId: z.string().min(1) });
const TOPICS = ['order', 'payment', 'auction', 'sell', 'kyc', 'account', 'technical', 'other', 'general'] as const;

export const createTicketBody = z.object({
  topic: z.enum(TOPICS).default('general'),
  subject: z.string().trim().min(3).max(160),
  body: z.string().trim().min(1).max(4000),
  relatedTo: z.object({ type: z.string().max(40), id: z.string().max(80) }).optional(),
  attachmentIds: z.array(z.string()).max(5).optional(),
});
const messageBody = z.object({ body: z.string().trim().min(1).max(4000), attachmentIds: z.array(z.string()).max(5).optional() });
export const mobileTicketsQuery = z.object({ status: z.enum(['open', 'resolved']).optional(), limit: z.coerce.number().int().min(1).max(100).optional(), cursor: z.string().optional() });
export const webTicketsQuery = z.object({ status: z.enum(['open', 'resolved']).optional(), page: z.coerce.number().int().min(1).optional(), perPage: z.coerce.number().int().min(1).max(100).optional() });
const attachmentBody = z.object({ filename: z.string().min(1).max(200), contentType: z.string().min(3).max(100), bytes: z.number().int().positive() });
const chatStartBody = z.object({ topic: z.string().max(60).optional() }).default({});
const chatMessageBody = z.object({ body: z.string().trim().min(1).max(2000), clientId: z.string().max(80).optional() });
const callbackBody = z.object({
  phone: z.string().min(7).max(20).optional(),
  topic: z.string().max(60).optional(),
  note: z.string().max(500).optional(),
  preferredWindow: z.string().max(60).optional(),
  relatedTo: z.object({ type: z.string().max(40), id: z.string().max(80) }).optional(),
});

/* -- mappers ----------------------------------------------------------------------------- */

const last = (t: ISupportTicket) => t.messages[t.messages.length - 1];

const mobileMsg = (m: ISupportTicket['messages'][number]) => ({ id: m._id, author: m.author, authorName: m.authorName ?? null, body: m.body, attachmentIds: m.attachmentIds, at: iso(m.at) });

export const toMobileTicket = (t: ISupportTicket) => ({
  id: t._id,
  reference: t.reference,
  topic: t.topic,
  subject: t.subject,
  status: t.status,
  relatedTo: t.relatedTo ?? null,
  lastMessagePreview: last(t)?.body.slice(0, 120) ?? '',
  lastMessageAt: iso(last(t)?.at ?? t.updatedAt),
  ago: agoDisplay(last(t)?.at ?? t.updatedAt, now()),
  messageCount: t.messages.length,
  createdAt: iso(t.createdAt),
});

export const toMobileTicketDetail = (t: ISupportTicket) => ({ ...toMobileTicket(t), messages: t.messages.map(mobileMsg), version: t.version });

export const toWebTicket = (t: ISupportTicket) => ({
  id: t._id,
  reference: t.reference,
  subject: t.subject,
  topic: t.topic,
  status: t.status,
  relatedTo: t.relatedTo ?? null,
  createdAt: iso(t.createdAt),
  updatedAt: iso(t.updatedAt),
});

export const toWebTicketDetail = (t: ISupportTicket) => ({
  ...toWebTicket(t),
  messages: t.messages.map((m) => ({ id: m._id, author: m.author, authorName: m.authorName ?? null, body: m.body, attachments: m.attachmentIds.map((id) => ({ id, url: uploadsService.signed(id).url })), createdAt: iso(m.at) })),
});

const chatMsg = (m: IChatMessage) => ({ id: m._id, clientId: m.clientId ?? null, author: m.author, body: m.body, at: iso(m.at), readAt: iso(m.readAt) });
const chatView = (s: IChatSession) => ({ id: s._id, status: s.status, agent: s.agent ?? null, topic: s.topic ?? null, messages: s.messages.map(chatMsg), endedBy: s.endedBy ?? null, endedAt: iso(s.endedAt), createdAt: iso(s.createdAt) });

/* -- controller (list/create are shared and dispatched in app-clients/shared) ------------ */

export const supportController = {
  async listMobile(req: Request, res: Response) {
    const win = cursorWindow(req.query as { limit?: unknown; cursor?: unknown });
    const { rows, total, counts } = await svc.listTickets(currentUserId(req), req.query.status as 'open' | 'resolved' | undefined, win.skip, win.limit);
    res.json(buildCursorPage(rows.map(toMobileTicket), total, win, counts));
  },
  async listWeb(req: Request, res: Response) {
    const win = pageWindow(req.query as { page?: unknown; perPage?: unknown });
    const { rows, total } = await svc.listTickets(currentUserId(req), req.query.status as 'open' | 'resolved' | undefined, win.skip, win.perPage);
    res.json(buildOffsetPage(rows.map(toWebTicket), total, win));
  },
  async createMobile(req: Request, res: Response) {
    const userId = currentUserId(req);
    const out = await svc.createTicket({ userId, ...req.body, idempotencyKey: req.idempotencyKey });
    if (out.replayed) res.setHeader('Idempotent-Replay', 'true');
    res.status(201).json(toMobileTicketDetail(await svc.getTicket(userId, out.id)));
  },
  async createWeb(req: Request, res: Response) {
    const userId = currentUserId(req);
    const out = await svc.createTicket({ userId, ...req.body, idempotencyKey: req.idempotencyKey });
    if (out.replayed) res.setHeader('Idempotent-Replay', 'true');
    res.status(201).json(toWebTicketDetail(await svc.getTicket(userId, out.id)));
  },
};

const tid = (req: Request) => String(req.params.ticketId);
const sid = (req: Request) => String(req.params.sessionId);

/** Mobile-only support routes. */
export function mobileSupportRouter(): Router {
  const r = Router();
  const tp = validate({ params: ticketIdParam });
  const sp = validate({ params: sessionParam });

  r.get('/support/channels', ah(async (_req, res) => res.json({ data: (await contentService.reference('support-channel')).map((c) => ({ code: c.code, name: c.name, ...c.data })) })));
  r.get('/support/faqs', ah(async (_req, res) => res.json({ data: (await contentService.reference('faq')).map((f) => ({ id: f.code, question: f.name, answer: f.data.answer ?? '' })) })));

  r.get('/support/tickets/:ticketId', requireUser, tp, ah(async (req, res) => res.json(toMobileTicketDetail(await svc.getTicket(currentUserId(req), tid(req))))));
  r.post('/support/tickets/:ticketId/messages', requireUser, tp, validate({ body: messageBody }), ah(async (req, res) => res.status(201).json(toMobileTicketDetail(await svc.addUserMessage(currentUserId(req), tid(req), req.body)))));
  r.post('/support/tickets/:ticketId/resolve', requireUser, tp, ah(async (req, res) => res.json(toMobileTicketDetail(await svc.resolve(currentUserId(req), tid(req))))));

  r.post('/support/attachments', requireUser, validate({ body: attachmentBody }), ah(async (req, res) => {
    const out = await uploadsService.createTarget(currentUserId(req), { purpose: 'support-attachment', ...req.body });
    res.status(201).json({ fileId: out.file._id, upload: out.upload });
  }));

  r.post('/support/chat/sessions', requireUser, validate({ body: chatStartBody }), ah(async (req, res) => res.status(201).json(chatView(await svc.startChat(currentUserId(req), (req.body as { topic?: string }).topic)))));
  r.get('/support/chat/sessions/:sessionId', requireUser, sp, ah(async (req, res) => res.json(chatView(await svc.getChat(currentUserId(req), sid(req))))));
  // Contract path: GET /support/chat/sessions/{sessionId}/messages
  r.get('/support/chat/sessions/:sessionId/messages', requireUser, sp, ah(async (req, res) => {
    const session = await svc.getChat(currentUserId(req), sid(req));
    res.json({ data: session.messages.map(chatMsg), suggestions: ['Where is my order?', 'I need a callback', 'Update my KYC'] });
  }));
  r.post('/support/chat/sessions/:sessionId/messages', requireUser, sp, validate({ body: chatMessageBody }), ah(async (req, res) => {
    const out = await svc.sendChat(currentUserId(req), sid(req), req.body);
    res.status(201).json(chatMsg(out.message));
  }));
  r.post('/support/chat/sessions/:sessionId/end', requireUser, sp, ah(async (req, res) => res.json(chatView(await svc.endChat(currentUserId(req), sid(req))))));

  r.post('/support/contact-requests', requireUser, idempotencyKey(false), validate({ body: callbackBody }), ah(async (req, res) => {
    const c = await svc.requestCallback(currentUserId(req), req.body);
    res.status(201).json({ id: c._id, status: c.status, createdAt: iso(c.createdAt) });
  }));

  return r;
}

/** Web-only support routes. */
export function webSupportRouter(): Router {
  const r = Router();
  const tp = validate({ params: ticketIdParam });
  r.get('/support/tickets/:ticketId', requireUser, tp, ah(async (req, res) => res.json(toWebTicketDetail(await svc.getTicket(currentUserId(req), tid(req))))));
  r.post('/support/tickets/:ticketId/messages', requireUser, tp, validate({ body: messageBody }), ah(async (req, res) => res.status(201).json(toWebTicketDetail(await svc.addUserMessage(currentUserId(req), tid(req), req.body)))));
  r.post('/support/tickets/:ticketId/resolve', requireUser, tp, ah(async (req, res) => res.json(toWebTicketDetail(await svc.resolve(currentUserId(req), tid(req))))));
  // Contract: POST /support/chat-sessions
  r.post('/support/chat-sessions', requireUser, validate({ body: chatStartBody }), ah(async (req, res) => {
    res.status(201).json(chatView(await svc.startChat(currentUserId(req), (req.body as { topic?: string }).topic)));
  }));
  // Contract: POST /support/callbacks
  r.post('/support/callbacks', requireUser, idempotencyKey(false), validate({ body: callbackBody }), ah(async (req, res) => {
    const c = await svc.requestCallback(currentUserId(req), req.body);
    res.status(201).json({ id: c._id, status: c.status, createdAt: iso(c.createdAt) });
  }));
  return r;
}
