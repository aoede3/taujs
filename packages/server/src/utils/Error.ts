export type ServiceErrorKind =
  | 'infra' // internal infra failures: timeouts, DB down, coding bugs
  | 'upstream' // external HTTP/API dependency failed
  | 'domain' // business rule failure (e.g., not found, forbidden)
  | 'validation' // bad params or bad result shape
  | 'canceled' // aborted via AbortSignal
  | 'timeout'; // exceeded deadline

export class ServiceError extends Error {
  kind: ServiceErrorKind;
  httpStatus?: number;
  details?: unknown; // opaque diagnostic payload (validation issues, upstream body, etc.)
  override cause?: unknown;

  constructor(message: string, kind: ServiceErrorKind, opts: { httpStatus?: number; details?: unknown; cause?: unknown } = {}) {
    super(message);
    this.name = 'ServiceError';
    this.kind = kind;
    this.httpStatus = opts.httpStatus;
    this.details = opts.details;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

export const isServiceError = (e: unknown): e is ServiceError => e instanceof ServiceError;

export function normalizeServiceError(e: unknown, fallback: ServiceErrorKind = 'infra'): ServiceError {
  if (e instanceof ServiceError) return e;

  // Common abort shape (DOMException) from fetch/AbortController
  if ((e as any)?.name === 'AbortError') return new ServiceError('Request canceled', 'canceled', { httpStatus: 499, cause: e });

  return new ServiceError((e as any)?.message ?? 'Service failed', fallback, { cause: e });
}
