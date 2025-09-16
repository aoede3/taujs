import type { Logger } from './Logger';

const DEFAULT_HTTP_STATUS: Record<ServiceErrorKind, number> = {
  infra: 500,
  upstream: 502,
  domain: 404,
  validation: 400,
  canceled: 499,
  timeout: 504,
};

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
    this.httpStatus = opts.httpStatus ?? DEFAULT_HTTP_STATUS[kind];
    this.details = opts.details;
    if (opts.cause !== undefined) this.cause = opts.cause;
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

  static infra(message: string, details?: unknown, cause?: unknown) {
    return new ServiceError(message, 'infra', { details, cause });
  }
}

export const isServiceError = (e: unknown): e is ServiceError => e instanceof ServiceError;

export function normaliseServiceError(
  e: unknown,
  fallback: ServiceErrorKind = 'infra',
  logger?: { info?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void },
): ServiceError {
  const serviceError =
    e instanceof ServiceError
      ? e
      : (e as any)?.name === 'AbortError'
        ? new ServiceError('Request canceled', 'canceled', { httpStatus: 499, cause: e })
        : new ServiceError((e as any)?.message ?? 'Service failed', fallback, { cause: e });

  if (logger?.error) {
    logger.error(`ServiceError [${serviceError.kind}]`, {
      message: serviceError.message,
      httpStatus: serviceError.httpStatus,
      details: serviceError.details,
      cause: serviceError.cause,
    });
  }

  return serviceError;
}
