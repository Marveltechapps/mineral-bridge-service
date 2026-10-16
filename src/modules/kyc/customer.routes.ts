import { Router } from 'express';
import { byClient } from '../../common/middleware/by-client.js';
import { createMobileKycRouter } from './mobile.kyc.routes.js';
import { createWebKycRouter } from './web.kyc.routes.js';

/** Customer KYC under `/v1`: mobile `/kyc/*` and web `/kyc` are different surfaces over one service. */
export function createCustomerKycRouter(): Router {
  const r = Router();
  r.use(byClient({ mobile: createMobileKycRouter(), web: createWebKycRouter() }));
  return r;
}
