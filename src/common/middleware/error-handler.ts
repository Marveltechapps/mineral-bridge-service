import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors/app-error.js';
import { logger } from '../../config/logger.js';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(
    new AppError({
      status: 404,
      code: 'resource/not-found',
      message: `No route for ${req.method} ${req.originalUrl}`,
    }),
  );
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) return;

  if (err instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const issue of err.issues) {
      const key = issue.path.join('.') || '_';
      if (!fields[key]) fields[key] = issue.message;
    }
    const firstField = Object.values(fields)[0];
    res.status(422).json({
      code: 'validation/failed',
      message: firstField || 'Validation failed',
      fields,
      requestId: req.requestId,
    });
    return;
  }

  if (err instanceof AppError) {
    if (err.status === 429 && err.details?.retryAfterSeconds != null) {
      res.setHeader('Retry-After', String(err.details.retryAfterSeconds));
    }

    const body: Record<string, unknown> = {
      code: err.code,
      message: err.message,
      requestId: req.requestId,
    };
    if (err.fields) body.fields = err.fields;
    if (err.details) body.details = err.details;
    if (err.hint) body.hint = err.hint;
    if (err.kycStatus) body.kycStatus = err.kycStatus;
    if (err.current !== undefined) body.current = err.current;

    res.status(err.status).json(body);
    return;
  }

  const message = err instanceof Error ? err.message : 'Unexpected error';
  logger.error({ err, requestId: req.requestId }, 'Unhandled error');

  // CORS denial from cors package
  if (message.startsWith('CORS origin denied')) {
    res.status(403).json({
      code: 'auth/forbidden',
      message: 'Origin not allowed',
      requestId: req.requestId,
    });
    return;
  }

  res.status(500).json({
    code: 'server/internal',
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : message,
    requestId: req.requestId,
  });
}
