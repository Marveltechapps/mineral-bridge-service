import type { Request, Response } from 'express';
import { SampleValidationError } from './sample.error.js';
import { listSamples } from './sample.service.js';
import { sampleQuerySchema } from './sample.validation.js';

export function getSamples(req: Request, res: Response): void {
  const query = sampleQuerySchema.safeParse(req.query);
  if (!query.success) {
    throw new SampleValidationError(query.error.flatten());
  }
  res.json(listSamples(query.data.limit));
}
