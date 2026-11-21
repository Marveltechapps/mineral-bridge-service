import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../common/middleware/validate.js';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { getUserContext, optionalUser, requireUser } from '../auth/auth.middleware.js';
import { v2DocumentsService } from './v2.documents.service.js';

export function createV2DocumentsRouter(): Router {
  const r = Router();

  r.get(
    '/:number',
    optionalUser,
    validate({ query: z.object({ format: z.enum(['json', 'pdf']).optional() }) }),
    asyncHandler(async (req, res) => {
      const userId = req.actor?.kind === 'user' ? req.actor.userId : undefined;
      // Prefer requireUser when format needs ownership — optional for public product docs
      const format = ((req.query as { format?: string }).format ?? 'json') as 'json' | 'pdf';
      if (!userId && format) {
        // still allow; service enforces ownership for order docs
      }
      const result = await v2DocumentsService.getByNumber({
        number: String(req.params.number),
        userId,
        format,
      });
      if (result.kind === 'pdf') {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
        res.send(result.buffer);
        return;
      }
      res.json(result.document);
    }),
  );

  return r;
}

/** Mount under authenticated context when listing — used from orders router. */
export { requireUser, getUserContext, v2DocumentsService };
