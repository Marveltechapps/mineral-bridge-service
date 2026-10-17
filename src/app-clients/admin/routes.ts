import { Router } from 'express';
import { walkRoutes } from '../../common/http/route-walk.js';
import { createAdminAuthRouter } from '../../modules/auth/admin.auth.routes.js';
import { academyRoutes } from '../../modules/admin/content/academy.routes.js';
import { marketingRoutes } from '../../modules/admin/content/marketing.routes.js';
import { analyticsRoutes } from '../../modules/admin/analytics/analytics.routes.js';
import { auctionRoutes } from '../../modules/admin/auctions/auctions.routes.js';
import { auditRoutes } from '../../modules/admin/audit/audit.routes.js';
import { chainRoutes } from '../../modules/admin/chain/chain.routes.js';
import { collabRoutes } from '../../modules/admin/collab/collab.routes.js';
import { lcRoutes } from '../../modules/admin/lc/lc.routes.js';
import { listingRoutes } from '../../modules/admin/listings/listings.routes.js';
import { orderRoutes } from '../../modules/admin/orders/orders.routes.js';
import { overviewRoutes } from '../../modules/admin/overview/overview.routes.js';
import { partnerRoutes } from '../../modules/admin/partners/partners.routes.js';
import { complianceRoutes } from '../../modules/admin/people/compliance.routes.js';
import { disputeRoutes } from '../../modules/admin/people/disputes.routes.js';
import { userRoutes } from '../../modules/admin/people/users.routes.js';
import { pricingRoutes } from '../../modules/admin/pricing/pricing.routes.js';
import { profileRoutes } from '../../modules/admin/profile/profile.routes.js';
import { settingsRoutes } from '../../modules/admin/settings/settings.routes.js';
import { settlementRoutes } from '../../modules/admin/settlements/settlements.routes.js';
import { buildAdminRouter, toInventoryPath, type AdminRouteDef } from '../../modules/admin/shared/route-kit.js';
import { shellRoutes } from '../../modules/admin/shell/shell.routes.js';
import { supportRoutes } from '../../modules/admin/support/support.routes.js';
import { catalogAdminRoutes } from '../../modules/admin/catalog/catalog.routes.js';
import { vaultRoutes } from '../../modules/admin/vault/vault.routes.js';

/** Endpoints #13–139. Endpoints #1–12 (auth, GET /me) live in modules/auth/admin.auth.routes.ts. */
export const adminRouteDefs: AdminRouteDef[] = [
  ...shellRoutes, //            #13–19
  ...overviewRoutes, //         #20–22
  ...orderRoutes, //            #23–33
  ...vaultRoutes, //            #34–37
  ...listingRoutes, //          #38–45
  ...pricingRoutes, //          #46–52
  ...auctionRoutes, //          #53–66
  ...lcRoutes, //               #67–73
  ...collabRoutes, //           #74–81
  ...chainRoutes, //            #82–87
  ...userRoutes, //             #88–97
  ...complianceRoutes, //       #98–101
  ...disputeRoutes, //          #102–107
  ...academyRoutes, //          #108–112
  ...marketingRoutes, //        #113–115
  ...partnerRoutes, //          #116–118
  ...supportRoutes, //          #119–122
  ...auditRoutes, //            #123–124
  ...settlementRoutes, //       #125–127
  ...analyticsRoutes, //        #128
  ...settingsRoutes, //         #129–134
  ...profileRoutes, //          #135–139
];

export type RegistryEntry = { n: number | null; method: string; path: string; source: 'admin' | 'auth' };

/** Every METHOD + inventory-style path served under /admin/v1 (used by scripts/audit-endpoint-coverage.ts). */
export function adminRouteRegistry(): RegistryEntry[] {
  const auth = walkRoutes(createAdminAuthRouter()).map((r) => ({ n: null, method: r.method, path: toInventoryPath(r.path), source: 'auth' as const }));
  const rest = adminRouteDefs.map((d) => ({ n: d.n, method: d.method, path: toInventoryPath(d.path), source: 'admin' as const }));
  return [...auth, ...rest];
}

/** `/admin/v1` router: auth (#1–12) + every privileged endpoint (#13–139). */
export function createAdminRouter(): Router {
  const r = Router();
  r.use(createAdminAuthRouter());
  r.use(buildAdminRouter(adminRouteDefs));
  // Hierarchy reads sit beside the numbered inventory so #13–139 stay unchanged.
  r.use(buildAdminRouter(catalogAdminRoutes));
  return r;
}
