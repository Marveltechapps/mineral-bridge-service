import { createHash } from 'node:crypto';
import { Router } from 'express';
import { notFound } from '../../common/errors/app-error.js';
import { ah } from '../../common/http/async-handler.js';
import { iso } from '../../common/utils/time-display.js';
import { webQuantity } from '../../common/utils/quantity.js';
import { PassportEventModel, PassportModel } from '../../models/web-trade.model.js';
import type { IPassport, IPassportEvent } from '../../models/web-trade.model.js';
import { optionalUser } from '../auth/auth.middleware.js';

const toAnchor = (a: IPassportEvent['anchor']) =>
  a ? { hash: a.hash, network: a.network, blockNumber: a.blockNumber, anchoredAt: iso(a.anchoredAt) } : null;

async function load(id: string): Promise<IPassport> {
  const p = await PassportModel.findById(id).lean<IPassport>();
  if (!p) throw notFound('passport/not-found', 'Passport not found');
  return p;
}

/** Hash that chains events so tampering with any earlier event changes the head. */
export function chainHash(prev: string, e: { title: string; occurredAt: Date; index: number }): string {
  return createHash('sha256').update(`${prev}|${e.index}|${e.title}|${e.occurredAt.toISOString()}`).digest('hex');
}

export function webPassportsRouter(): Router {
  const r = Router();

  r.get('/passports/:passportId', optionalUser, ah(async (req, res) => {
    const p = await load(String(req.params.passportId));
    res.json({
      id: p._id,
      lotId: p.lotId ?? null,
      mineral: p.mineral,
      origin: p.origin,
      quantity: webQuantity(p.grams),
      purity: p.purity ?? null,
      custody: p.custody,
      anchorHash: p.anchorHash,
      issuedAt: iso(p.createdAt),
    });
  }));

  r.get('/passports/:passportId/events', optionalUser, ah(async (req, res) => {
    const p = await load(String(req.params.passportId));
    const events = await PassportEventModel.find({ passportId: p._id }).sort({ index: 1 }).lean<IPassportEvent[]>();
    res.json({
      passportId: p._id,
      items: events.map((e) => ({
        id: e._id,
        index: e.index,
        title: e.title,
        actor: e.actor ?? null,
        location: e.location ?? null,
        occurredAt: iso(e.occurredAt),
        anchor: toAnchor(e.anchor),
      })),
    });
  }));

  return r;
}
