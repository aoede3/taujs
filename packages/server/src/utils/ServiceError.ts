const DEFAULT_HTTP_STATUS: Record<ServiceErrorKind, number> = {
  infra: 500,
  upstream: 502,
  domain: 404,
  validation: 400,
  canceled: 499,
  timeout: 504,
} as const;

export type ServiceErrorKind =
  | 'infra' // internal infra failures: timeouts, DB down, coding bugs
  | 'upstream' // external HTTP/API dependency failed
  | 'domain' // business rule failure (e.g., not found, forbidden)
  | 'validation' // bad params or bad result shape
  | 'canceled' // aborted via AbortSignal
  | 'timeout'; // exceeded deadline

export class ServiceError extends Error {
  kind: ServiceErrorKind;
  httpStatus: number;
  details?: unknown;
  override cause?: unknown;
  safeMessage: string;

  constructor(message: string, kind: ServiceErrorKind, opts: { httpStatus?: number; details?: unknown; cause?: unknown; safeMessage?: string } = {}) {
    super(message);
    this.name = 'ServiceError';
    this.kind = kind;
    this.httpStatus = opts.httpStatus ?? DEFAULT_HTTP_STATUS[kind];
    this.details = opts.details;
    if (opts.cause !== undefined) this.cause = opts.cause;

    this.safeMessage = opts.safeMessage ?? (kind === 'domain' || kind === 'validation' ? message : 'Internal Server Error');
  }

  static notFound(message: string, details?: unknown) {
    return new ServiceError(message, 'domain', { httpStatus: 404, details });
  }

  static forbidden(message: string, details?: unknown) {
    return new ServiceError(message, 'domain', { httpStatus: 403, details });
  }

  static badRequest(message: string, details?: unknown) {
    return new ServiceError(message, 'validation', { httpStatus: 400, details });
  }

  static timeout(message: string, details?: unknown) {
    return new ServiceError(message, 'timeout', { details });
  }

  static infra(message: string, opts: { details?: unknown; cause?: unknown } = {}) {
    return new ServiceError(message, 'infra', opts);
  }

  static upstream(message: string, opts: { details?: unknown; cause?: unknown } = {}) {
    return new ServiceError(message, 'upstream', opts);
  }
}

export const isServiceError = (err: unknown): err is ServiceError => err instanceof ServiceError;

export const normaliseServiceError = (err: unknown, fallback: ServiceErrorKind = 'infra'): ServiceError => {
  if (err instanceof ServiceError) return err;

  if ((err as any)?.name === 'AbortError') {
    return new ServiceError('Request canceled', 'canceled', {
      httpStatus: 499,
      cause: err,
    });
  }

  return new ServiceError((err as any)?.message ?? 'Service failed', fallback, {
    cause: err,
  });
};

export const logServiceError = (logger: { error: (...a: unknown[]) => void }, err: ServiceError) => {
  logger.error(`[service:${err.kind}] ${err.message}`, {
    httpStatus: err.httpStatus,
    details: err.details,
    cause: err.cause,
  });
};
