import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from '../errors/app-error.js';

/**
 * One route, two contracts (ARCHITECTURE §3.3). `Router` instances are valid handlers,
 * so a whole module router can be dispatched per client.
 * A client with no registered handler gets `404 route/not-available`.
 */
export function byClient(handlers: { mobile?: RequestHandler; web?: RequestHandler }): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const client = req.apiClient;
    const handler = client === 'mobile' ? handlers.mobile : client === 'web' ? handlers.web : undefined;
    if (!handler) {
      next(
        new AppError({
          status: 404,
          code: 'route/not-available',
          message: `${req.method} ${req.originalUrl} is not available for this client`,
        }),
      );
      return;
    }
    handler(req, res, next);
  };
}
