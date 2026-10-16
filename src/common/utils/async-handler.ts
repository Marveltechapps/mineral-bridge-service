import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Express 4 does not forward rejected promises to the error handler — this does.
 *
 * It also serves as middleware: a handler that resolves WITHOUT having started a response
 * (e.g. `requireStaff`, which only binds `req.actor`) falls through to `next()`. Without this such
 * middleware would leave the request hanging forever.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res, next))
      .then(() => {
        if (!res.headersSent && !res.writableEnded) next();
      })
      .catch(next);
  };
}
