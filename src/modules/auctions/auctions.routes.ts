import { Router } from 'express';
import { ah } from '../../common/http/async-handler.js';
import { validate } from '../../common/middleware/validate.js';
import { requireKyc, requireUser } from '../auth/auth.middleware.js';
import { auctionsController as c } from './auctions.controller.js';
import * as v from './auctions.validation.js';

/** Mobile-only: result, my bids, watch. (list/detail/bids are shared; see app-clients/shared.) */
export function mobileAuctionsRouter(): Router {
  const r = Router();
  r.get('/auctions/:auctionId/result', requireUser, validate({ params: v.auctionIdParam }), ah(c.result));
  r.get('/me/bids', requireUser, validate({ query: v.myBidsQuery }), ah(c.myBids));
  r.post('/auctions/:auctionId/watch', requireUser, validate({ params: v.auctionIdParam, body: v.watchBody }), ah(c.watch));
  return r;
}

/** Web-only: auto-bid and reminders. */
export function webAuctionsRouter(): Router {
  const r = Router();
  const p = validate({ params: v.auctionIdParam });
  r.put('/auctions/:auctionId/auto-bid', requireUser, requireKyc, p, validate({ body: v.autoBidBody }), ah(c.putAutoBid));
  r.delete('/auctions/:auctionId/auto-bid', requireUser, requireKyc, p, ah(c.deleteAutoBid));
  r.post('/auctions/:auctionId/reminder', requireUser, p, validate({ body: v.reminderBody }), ah(c.setReminder));
  r.delete('/auctions/:auctionId/reminder', requireUser, p, ah(c.deleteReminder));
  return r;
}
