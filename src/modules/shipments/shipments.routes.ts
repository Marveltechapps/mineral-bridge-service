import { Router } from 'express';
import { z } from 'zod';
import { currentUserId } from '../../common/http/actor.js';
import { ah } from '../../common/http/async-handler.js';
import { validate } from '../../common/middleware/validate.js';
import { createSignedUrl } from '../../common/storage/signed-url.js';
import { conflict, notFound } from '../../common/errors/app-error.js';
import { buildOffsetPage, pageWindow } from '../../common/utils/cursor.js';
import { webMoney } from '../../common/utils/currency.js';
import { now } from '../../common/utils/clock.js';
import { opaqueId } from '../../common/utils/ids.js';
import { references } from '../../common/utils/references.js';
import { iso } from '../../common/utils/time-display.js';
import { ShipmentModel } from '../../models/contract-lc.model.js';
import type { IShipment, ShipmentStatus } from '../../models/contract-lc.model.js';
import { channels, realtimeHub } from '../../realtime/auction-hub.js';
import { requireUser } from '../auth/auth.middleware.js';
import { notifyUser } from '../notifications/notifications.service.js';
import { StateMachine } from '../../common/utils/state-machine.js';

export const shipmentMachine = new StateMachine<ShipmentStatus>(
  'shipment',
  {
    booked: ['loaded', 'delayed', 'pickup_scheduled'],
    loaded: ['in_transit', 'delayed'],
    in_transit: ['discharged', 'delayed', 'picked_up'],
    delayed: ['loaded', 'in_transit', 'discharged'],
    discharged: ['delivered'],
    delivered: [],
    pickup_scheduled: ['picked_up', 'delayed'],
    picked_up: ['in_transit', 'received_at_vault', 'delayed'],
    received_at_vault: ['delivered'],
  },
  'shipment/invalid-transition',
);

const PROGRESS: Record<ShipmentStatus, number> = {
  booked: 5,
  loaded: 25,
  in_transit: 60,
  delayed: 60,
  discharged: 90,
  delivered: 100,
  pickup_scheduled: 10,
  picked_up: 40,
  received_at_vault: 95,
};

export const shipmentsService = {
  async get(userId: string, id: string): Promise<IShipment> {
    const s = await ShipmentModel.findOne({ _id: id, ownerIds: userId }).lean<IShipment>();
    if (!s) throw notFound('shipment/not-found', 'Shipment not found');
    return s;
  },

  async list(userId: string, status: ShipmentStatus | undefined, skip: number, limit: number) {
    const filter = { ownerIds: userId, ...(status ? { status } : {}) };
    const [rows, total] = await Promise.all([
      ShipmentModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean<IShipment[]>(),
      ShipmentModel.countDocuments(filter),
    ]);
    return { rows, total };
  },

  /** Desk/logistics-side operations (called by the admin console and carrier webhooks). */
  desk: {
    async create(input: Omit<IShipment, '_id' | 'reference' | 'createdAt' | 'status' | 'events' | 'documents' | 'progressPercent'>) {
      const doc = await ShipmentModel.create({
        ...input,
        reference: await references.shipment(),
        status: 'booked',
        progressPercent: PROGRESS.booked,
        events: [{ _id: opaqueId('sev'), index: 0, title: 'Booking confirmed', occurredAt: now(), projected: false }],
        documents: [],
      });
      return doc.toObject() as IShipment;
    },

    /** Appends an event and (optionally) advances status with a version-free CAS on the previous status. */
    async addEvent(id: string, input: { title: string; location?: string; actor?: string; status?: ShipmentStatus }) {
      const s = await ShipmentModel.findById(id).lean<IShipment>();
      if (!s) throw notFound('shipment/not-found', 'Shipment not found');
      const set: Record<string, unknown> = {};
      if (input.status && input.status !== s.status) {
        shipmentMachine.assert(s.status, input.status);
        set.status = input.status;
        set.progressPercent = PROGRESS[input.status];
        if (input.status === 'in_transit' && !s.departedAt) set.departedAt = now();
        if (input.status === 'delivered') set.actualArrival = now();
      }
      const event = { _id: opaqueId('sev'), index: s.events.length, title: input.title, location: input.location, actor: input.actor, occurredAt: now(), projected: false };
      const updated = await ShipmentModel.findOneAndUpdate(
        { _id: id, status: s.status, 'events.0': { $exists: true }, events: { $size: s.events.length } },
        { $set: set, $push: { events: event } },
        { new: true },
      ).lean<IShipment>();
      if (!updated) throw conflict('shipment/state-changed', 'The shipment changed concurrently.');
      realtimeHub.publish(channels.user(s.ownerIds[0] ?? 'none'), 'shipment.updated', { shipmentId: id, status: updated.status });
      for (const uid of s.ownerIds) await notifyUser(uid, { event: 'order.stage_changed', title: `Shipment ${s.reference}: ${input.title}`, target: { type: 'shipment', id } });
      return updated;
    },
  },
};

const toWebShipment = (s: IShipment) => ({
  id: s._id,
  reference: s.reference,
  lotDescription: s.lotDescription,
  billOfLading: s.billOfLading,
  lcId: s.lcId ?? null,
  orderId: s.orderId ?? null,
  contractId: s.contractId ?? null,
  route: s.route,
  departedAt: iso(s.departedAt),
  estimatedArrival: iso(s.estimatedArrival),
  actualArrival: iso(s.actualArrival),
  progressPercent: s.progressPercent,
  vessel: s.vessel,
  container: s.container,
  insuredValue: s.insuredValue ? webMoney(s.insuredValue) : null,
  incoterm: s.incoterm,
  status: s.status,
  createdAt: iso(s.createdAt),
});

const idParam = z.object({ shipmentId: z.string().min(1) });
const listQuery = z.object({
  status: z.enum(['booked', 'loaded', 'in_transit', 'discharged', 'delivered', 'delayed']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  perPage: z.coerce.number().int().min(1).max(100).optional(),
});

/** Web `/shipments/*` (read-only for customers). */
export function webShipmentsRouter(): Router {
  const r = Router();
  const id = validate({ params: idParam });

  r.get('/shipments', requireUser, validate({ query: listQuery }), ah(async (req, res) => {
    const win = pageWindow(req.query as { page?: unknown; perPage?: unknown });
    const { rows, total } = await shipmentsService.list(currentUserId(req), req.query.status as ShipmentStatus | undefined, win.skip, win.perPage);
    res.json(buildOffsetPage(rows.map(toWebShipment), total, win));
  }));
  r.get('/shipments/:shipmentId', requireUser, id, ah(async (req, res) => {
    res.json(toWebShipment(await shipmentsService.get(currentUserId(req), String(req.params.shipmentId))));
  }));
  r.get('/shipments/:shipmentId/events', requireUser, id, ah(async (req, res) => {
    const s = await shipmentsService.get(currentUserId(req), String(req.params.shipmentId));
    res.json({ items: s.events.map((e) => ({ id: e._id, index: e.index, title: e.title, actor: e.actor ?? null, location: e.location ?? null, occurredAt: iso(e.occurredAt), projected: e.projected, anchor: e.anchor ?? null })) });
  }));
  r.get('/shipments/:shipmentId/documents', requireUser, id, ah(async (req, res) => {
    const s = await shipmentsService.get(currentUserId(req), String(req.params.shipmentId));
    res.json({ items: s.documents.map((d) => ({ id: d._id, kind: d.kind, name: d.name, url: d.fileId ? createSignedUrl('file', d.fileId).url : null })) });
  }));

  return r;
}
