import { AppError } from '../../common/errors/app-error.js';

export class SampleValidationError extends AppError {
  constructor(details?: unknown) {
    super({
      status: 400,
      code: 'validation/sample',
      message: 'Invalid sample query',
      details: details && typeof details === 'object' ? (details as Record<string, unknown>) : undefined,
    });
    this.name = 'SampleValidationError';
  }
}
