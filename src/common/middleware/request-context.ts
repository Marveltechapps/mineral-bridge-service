import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

export type ApiClient = 'mobile' | 'web' | 'admin' | 'unknown';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      apiClient: ApiClient;
      rawBody?: Buffer;
    }
  }
}

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && incoming.length > 0 ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);

  const xClient = (req.header('x-client') ?? '').toLowerCase();
  if (req.path.startsWith('/admin') || req.baseUrl.startsWith('/admin')) {
    req.apiClient = 'admin';
  } else if (xClient.includes('mobile') || xClient.includes('mineralbridge-mobile')) {
    req.apiClient = 'mobile';
  } else if (xClient.includes('web') || xClient.includes('mineralbridge-web')) {
    req.apiClient = 'web';
  } else {
    // Web SPA does not send X-Client today — default shared /v1 routes to web
    req.apiClient = 'web';
  }

  next();
}
