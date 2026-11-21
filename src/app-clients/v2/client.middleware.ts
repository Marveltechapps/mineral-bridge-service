import type { RequestHandler } from 'express';
import { badRequest } from '../../common/errors/app-error.js';

/**
 * Doc 07 conventions: `X-Client: mobile | web | admin` (or legacy mineralbridge-* prefixes).
 * Sets `req.apiClient` for downstream auth.
 */
export const requireV2Client: RequestHandler = (req, _res, next) => {
  const raw = (req.header('x-client') ?? '').trim().toLowerCase();
  const platform = (req.header('x-platform') ?? '').toLowerCase();

  let client: 'mobile' | 'web' | 'admin' | null = null;
  if (raw === 'mobile' || raw.startsWith('mineralbridge-mobile')) client = 'mobile';
  else if (raw === 'web' || raw.startsWith('mineralbridge-web')) client = 'web';
  else if (raw === 'admin' || raw.startsWith('mineralbridge-admin')) client = 'admin';
  else if (platform === 'android' || platform === 'ios') client = 'mobile';

  if (!client) {
    return next(
      badRequest('request/client-required', 'Send X-Client: mobile | web | admin on /v2 requests.'),
    );
  }
  req.apiClient = client;
  next();
};

/** Customer `/v2` routes reject admin client header. */
export const requireCustomerV2Client: RequestHandler = (req, _res, next) => {
  if (req.apiClient !== 'mobile' && req.apiClient !== 'web') {
    return next(badRequest('request/client-invalid', 'Customer /v2 requires X-Client: mobile or web.'));
  }
  next();
};

/** Admin `/v2/admin` routes require admin client. */
export const requireAdminV2Client: RequestHandler = (req, _res, next) => {
  if (req.apiClient !== 'admin') {
    return next(badRequest('request/client-invalid', 'Admin /v2 requires X-Client: admin.'));
  }
  next();
};
