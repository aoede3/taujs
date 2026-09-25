/**
 * Stable application-error categories. Their default HTTP statuses are respectively 500, 502,
 * 404, 400, 403, 499 and 504; an {@link AppError} may explicitly override its status.
 */
export type ErrorKind = 'infra' | 'upstream' | 'domain' | 'validation' | 'auth' | 'canceled' | 'timeout';

const HTTP_STATUS: Record<ErrorKind, number> = {
  infra: 500,
  upstream: 502,
  domain: 404,
  validation: 400,
  auth: 403,
  canceled: 499, // Client Closed Request (nginx convention)
  timeout: 504,
} as const;

// Global-registry brand so AppError identity survives duplicate copies of this
// class (multiple bundle entry points, nested installs, version skew).
// `instanceof` alone fails across those boundaries and turned domain errors
// (404s) into 500s at the callServiceMethod boundary.
const APP_ERROR_BRAND = Symbol.for('taujs.AppError');

/**
 * An error with a stable {@link ErrorKind}, HTTP status and client-safe message. Domain,
 * validation and auth messages are safe by default; other kinds default to a generic message.
 */
export class AppError extends Error {
  readonly kind: ErrorKind;
  readonly httpStatus: number;
  readonly details?: unknown;
  readonly safeMessage: string;
  readonly code?: string;
  /** Creates an error, optionally overriding its status or safe message and attaching details, a cause or code. */
  constructor(
    message: string,
    kind: ErrorKind,
    options: { httpStatus?: number; details?: unknown; cause?: unknown; safeMessage?: string; code?: string } = {},
  ) {
    super(message);
    this.name = 'AppError';
    Object.setPrototypeOf(this, new.target.prototype);
    Object.defineProperty(this, APP_ERROR_BRAND, { value: true, enumerable: false });

    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        value: options.cause,
        enumerable: false,
        writable: false,
        configurable: true,
      });
    }

    this.kind = kind;
    this.httpStatus = options.httpStatus ?? HTTP_STATUS[kind];
    this.details = options.details;
    this.safeMessage = options.safeMessage ?? this.getSafeMessage(kind, message);
    this.code = options.code;

    if ((Error as any).captureStackTrace) (Error as any).captureStackTrace(this, this.constructor);
  }

  private getSafeMessage(kind: ErrorKind, message: string): string {
    return kind === 'domain' || kind === 'validation' || kind === 'auth' ? message : 'Internal Server Error';
  }

  private serialiseValue(value: unknown, seen = new WeakSet<object>()): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value;
    if (seen.has(value as object)) return '[circular]';
    seen.add(value as object);

    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
        ...(AppError.isAppError(value) && {
          kind: value.kind,
          httpStatus: value.httpStatus,
          code: value.code,
        }),
      };
    }

    if (Array.isArray(value)) return value.map((item) => this.serialiseValue(item, seen));

    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = this.serialiseValue(val, seen);
    }

    return result;
  }

  toJSON() {
    return {
      name: this.name,
      kind: this.kind,
      message: this.message,
      safeMessage: this.safeMessage,
      httpStatus: this.httpStatus,
      ...(this.code && { code: this.code }),
      details: this.serialiseValue(this.details),
      stack: this.stack,
      ...((this as any).cause && {
        cause: this.serialiseValue((this as any).cause),
      }),
    };
  }

  /** Creates a `domain` error with HTTP status 404. */
  static notFound(message: string, details?: unknown, code?: string) {
    return new AppError(message, 'domain', { httpStatus: 404, details, code });
  }

  /** Creates an `auth` error with HTTP status 403. */
  static forbidden(message: string, details?: unknown, code?: string) {
    return new AppError(message, 'auth', { httpStatus: 403, details, code });
  }

  /** Creates a `validation` error with HTTP status 400. */
  static badRequest(message: string, details?: unknown, code?: string) {
    return new AppError(message, 'validation', { httpStatus: 400, details, code });
  }

  /** Creates a `validation` error with HTTP status 422. */
  static unprocessable(message: string, details?: unknown, code?: string) {
    return new AppError(message, 'validation', { httpStatus: 422, details, code });
  }

  /** Creates a `timeout` error with HTTP status 504. */
  static timeout(message: string, details?: unknown, code?: string) {
    return new AppError(message, 'timeout', { details, code });
  }

  /** Creates a `canceled` error with HTTP status 499. */
  static canceled(message: string, details?: unknown, code?: string) {
    return new AppError(message, 'canceled', { details, code });
  }

  /** Creates an `infra` error with HTTP status 500 and retains the optional cause. */
  static internal(message: string, cause?: unknown, details?: unknown, code?: string) {
    return new AppError(message, 'infra', { cause, details, code });
  }

  /** Creates an `upstream` error with HTTP status 502 and retains the optional cause. */
  static upstream(message: string, cause?: unknown, details?: unknown, code?: string) {
    return new AppError(message, 'upstream', { cause, details, code });
  }

  /** Creates an `infra` error with HTTP status 503 and retains the optional cause. */
  static serviceUnavailable(message: string, cause?: unknown, details?: unknown, code?: string) {
    return new AppError(message, 'infra', { httpStatus: 503, cause, details, code });
  }

  /**
   * Brand-based identity check: true for any AppError instance, including ones
   * constructed by a different copy of this class. Use this instead of
   * `instanceof AppError` everywhere an error may cross a module boundary.
   */
  static isAppError(value: unknown): value is AppError {
    return value instanceof AppError || (typeof value === 'object' && value !== null && (value as Record<PropertyKey, unknown>)[APP_ERROR_BRAND] === true);
  }

  /** Returns an existing `AppError`, or wraps another value as an `infra` error with that value as its cause. */
  static from(err: unknown, fallback = 'Internal error'): AppError {
    return AppError.isAppError(err) ? err : AppError.internal((err as any)?.message ?? fallback, err);
  }
}

type ErrorShape = { name: string; message: string; stack?: string };

export function normaliseError(e: unknown): ErrorShape {
  if (e instanceof Error) return { name: e.name, message: e.message, stack: e.stack };

  const hasMessageProp = e != null && typeof (e as any).message !== 'undefined';
  const msg = hasMessageProp ? String((e as any).message) : String(e);

  return { name: 'Error', message: msg };
}

export function toReason(e: unknown): Error {
  if (e instanceof Error) return e;

  if (e === null) return new Error('null');
  if (typeof e === 'undefined') return new Error('Unknown render error');

  const maybeMsg = (e as any)?.message;
  if (typeof maybeMsg !== 'undefined') return new Error(String(maybeMsg));

  return new Error(String(e));
}
