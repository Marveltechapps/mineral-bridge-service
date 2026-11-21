import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../common/middleware/validate.js';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { getUserContext, optionalUser, requireUser } from '../auth/auth.middleware.js';
import { enqueueOutbox } from '../outbox/outbox.service.js';
import { supportService } from './support.service.js';

export function createV2SupportRouter(): Router {
  const r = Router();

  r.get('/faqs', optionalUser, asyncHandler(async (_req, res) => {
    res.json({
      items: [
        { q: 'How do I verify my identity?', a: 'Open KYC from your profile and upload a government ID plus selfie.' },
        { q: 'How long does payment confirmation take?', a: 'Bank transfers are usually confirmed within one business day.' },
        { q: 'Can I cancel an order?', a: 'You can cancel before payment without a refund request. After payment, open a refund.' },
      ],
      contacts: {
        phone: process.env.SUPPORT_PHONE ?? '+2348000000000',
        whatsapp: process.env.SUPPORT_WHATSAPP ?? '+2348000000000',
        email: process.env.SUPPORT_EMAIL ?? 'support@mineralbridge.com',
      },
    });
  }));

  r.get('/threads', requireUser, asyncHandler(async (req, res) => {
    const { rows, total } = await supportService.listTickets(getUserContext(req).user.id, undefined, 0, 50);
    res.json({
      items: rows.map((t) => ({
        ref: t.reference,
        topic: t.topic,
        subject: t.subject,
        status: t.status,
        updatedAt: t.updatedAt.toISOString(),
      })),
      total,
    });
  }));

  r.post('/threads', requireUser, validate({ body: z.object({
    topic: z.enum(['general', 'other_payment_method', 'order', 'sell']),
    orderRef: z.string().optional(),
    body: z.string().min(1).max(4000),
    attachmentFileIds: z.array(z.string()).max(5).optional(),
  }) }), asyncHandler(async (req, res) => {
    const { user } = getUserContext(req);
    const b = req.body as { topic: string; orderRef?: string; body: string; attachmentFileIds?: string[] };
    const { id } = await supportService.createTicket({
      userId: user.id,
      topic: b.topic,
      subject: b.topic,
      body: b.body,
      relatedTo: b.orderRef ? { type: 'order', id: b.orderRef } : undefined,
      attachmentIds: b.attachmentFileIds,
    });
    void enqueueOutbox('support.ticket_opened', { ticketId: id, userId: user.id });
    const t = await supportService.getTicket(user.id, id);
    res.status(201).json({
      ref: t.reference,
      topic: t.topic,
      status: t.status,
      messages: t.messages,
    });
  }));

  r.get('/threads/:ref', requireUser, asyncHandler(async (req, res) => {
    const { user } = getUserContext(req);
    // Support tickets are keyed by id; also allow reference lookup via list filter.
    try {
      const t = await supportService.getTicket(user.id, String(req.params.ref));
      res.json(t);
    } catch {
      const { rows } = await supportService.listTickets(user.id, undefined, 0, 200);
      const t = rows.find((x) => x.reference === req.params.ref || x._id === req.params.ref);
      if (!t) throw await supportService.getTicket(user.id, String(req.params.ref));
      res.json(t);
    }
  }));

  r.post('/threads/:ref/messages', requireUser, validate({ body: z.object({ body: z.string().min(1).max(4000) }) }), asyncHandler(async (req, res) => {
    const { user } = getUserContext(req);
    const { rows } = await supportService.listTickets(user.id, undefined, 0, 200);
    const t = rows.find((x) => x.reference === req.params.ref || x._id === req.params.ref);
    const id = t?._id ?? String(req.params.ref);
    const updated = await supportService.addUserMessage(user.id, id, { body: (req.body as { body: string }).body });
    res.status(201).json(updated.messages[updated.messages.length - 1]);
  }));

  return r;
}
