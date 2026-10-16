export type ErrorDetails = Record<string, unknown>;
export type FieldErrors = Record<string, string | string[]>;

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: FieldErrors;
  readonly details?: ErrorDetails;
  readonly hint?: string;
  readonly kycStatus?: string;
  readonly current?: unknown;
  readonly expose: boolean;

  constructor(opts: {
    status: number;
    code: string;
    message: string;
    fields?: FieldErrors;
    details?: ErrorDetails;
    hint?: string;
    kycStatus?: string;
    current?: unknown;
    expose?: boolean;
  }) {
    super(opts.message);
    this.name = 'AppError';
    this.status = opts.status;
    this.code = opts.code;
    this.fields = opts.fields;
    this.details = opts.details;
    this.hint = opts.hint;
    this.kycStatus = opts.kycStatus;
    this.current = opts.current;
    this.expose = opts.expose ?? true;
  }
}

export function badRequest(code: string, message: string, fields?: FieldErrors) {
  return new AppError({ status: 400, code, message, fields });
}

export function unauthorized(code: string, message: string, details?: ErrorDetails) {
  return new AppError({ status: 401, code, message, details });
}

export function forbidden(code: string, message: string, extras?: Partial<AppError>) {
  return new AppError({ status: 403, code, message, ...extras });
}

export function notFound(code = 'resource/not-found', message = 'Resource not found') {
  return new AppError({ status: 404, code, message });
}

export function conflict(code: string, message: string, extras?: Partial<AppError>) {
  return new AppError({ status: 409, code, message, ...extras });
}

export function gone(code: string, message: string) {
  return new AppError({ status: 410, code, message });
}

export function unprocessable(message: string, fields?: FieldErrors, code = 'validation/failed') {
  return new AppError({ status: 422, code, message, fields });
}

export function locked(code: string, message: string, details?: ErrorDetails) {
  return new AppError({ status: 423, code, message, details });
}

export function tooMany(code: string, message: string, retryAfterSeconds?: number) {
  return new AppError({
    status: 429,
    code,
    message,
    details: retryAfterSeconds != null ? { retryAfterSeconds } : undefined,
  });
}

export function preconditionFailed(code: string, message: string, details?: ErrorDetails) {
  return new AppError({ status: 412, code, message, details });
}
