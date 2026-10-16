import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Router } from 'express';
import { AppError } from '../errors/app-error.js';
import type { ApiClient } from '../middleware/request-context.js';

type Handlers = { mobile?: RequestHandler | RequestHandler[]; web?: RequestHandler | RequestHandler[] };

function run(chain: RequestHandler[], req: Request, res: Response, next: NextFunction): void {
  let i = 0;
  const step = (err?: unknown): void => {
    if (err) return next(err);
    const h = chain[i++];
    if (!h) return next();
    try {
      h(req, res, step);
    } catch (e) {
      next(e);
    }
  };
  step();
}

/**
 * Dispatch a shared `METHOD + path` to the handler chain for `req.apiClient`.
 * A client with no handler gets `404 route/not-available` (ARCHITECTURE §2 rule 3).
 * Because `next()` is called after the chain finishes only when a handler passes through,
 * handlers are expected to terminate the response.
 */
export function byClient(handlers: Handlers): RequestHandler {
  return (req, res, next) => {
    const entry = req.apiClient === 'mobile' ? handlers.mobile : req.apiClient === 'web' ? handlers.web : undefined;
    if (!entry) {
      next(
        new AppError({
          status: 404,
          code: 'route/not-available',
          message: `${req.method} ${req.originalUrl} is not available to this client`,
        }),
      );
      return;
    }
    run(Array.isArray(entry) ? entry : [entry], req, res, next);
  };
}

/** Router that only participates for one client; other clients fall through (`next('router')`). */
export function clientRouter(client: Extract<ApiClient, 'mobile' | 'web'>): Router {
  const router = Router();
  router.use((req, _res, next) => {
    if (req.apiClient === client) next();
    else next('router');
  });
  return router;
}
