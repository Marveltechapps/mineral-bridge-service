import { Router } from 'express';
import { ah } from '../../common/http/async-handler.js';
import { byClient } from '../../common/http/by-client.js';
import { idempotencyKey } from '../../common/middleware/idempotency-key.js';
import { validate } from '../../common/middleware/validate.js';
import { optionalUser, requireKyc, requireTransactionPin, requireUser } from '../../modules/auth/auth.middleware.js';
import { auctionsController as c } from '../../modules/auctions/auctions.controller.js';
import * as v from '../../modules/auctions/auctions.validation.js';

/**
 * Shared `/auctions` paths (conflicts #11-#14).
 *  - mobile: `status`, cursor pages, `bidding{}` + `version`, PIN + acceptBinding on bids
 *  - web: `state`, offset pages, `AuctionDetail` with `viewer{}`, plain `{amount}` bids
 */
export function auctionsSharedRouter(): Router {
  const r = Router();
  const id = validate({ params: v.auctionIdParam });

  r.get(
    '/auctions',
    optionalUser,
    byClient({
      mobile: [validate({ query: v.mobileListQuery }), ah(c.listMobile)],
      web: [validate({ query: v.webListQuery }), ah(c.listWeb)],
    }),
  );

  r.get('/auctions/:auctionId', optionalUser, id, byClient({ mobile: ah(c.detailMobile), web: ah(c.detailWeb) }));

  r.get(
    '/auctions/:auctionId/bids',
    optionalUser,
    id,
    validate({ query: v.bidsQuery }),
    byClient({ mobile: ah(c.bidsMobile), web: ah(c.bidsWeb) }),
  );

  r.post(
    '/auctions/:auctionId/bids',
    requireUser,
    requireKyc,
    idempotencyKey(true),
    id,
    byClient({
      mobile: [requireTransactionPin, validate({ body: v.mobileBidBody }), ah(c.placeBidMobile)],
      web: [validate({ body: v.webBidBody }), ah(c.placeBidWeb)],
    }),
  );

  return r;
}
