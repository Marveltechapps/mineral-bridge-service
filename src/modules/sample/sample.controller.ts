import type { Request, Response } from 'express';
import { SampleValidationError } from './sample.error';
import { listSamples } from './sample.service';
import { sampleQuerySchema } from './sample.validation';

export function getSamples(req: Request, res: Response): void {
  const query = sampleQuerySchema.safeParse(req.query);
  if (!query.success) {
    throw new SampleValidationError(query.error.flatten());
  }
  res.json(listSamples(query.data.limit));
}
