import { AppError } from '../error';

export class SampleValidationError extends AppError {
  constructor(details?: unknown) {
    super('Invalid sample query', 400, 'VALIDATION_ERROR', details);
    this.name = 'SampleValidationError';
  }
}
