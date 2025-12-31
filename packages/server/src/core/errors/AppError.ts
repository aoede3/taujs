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

export class AppError extends Error {
  readonly kind: ErrorKind;
  readonly httpStatus: number;
  readonly details?: unknown;
  readonly safeMessage: string;
  readonly code?: string;
  constructor(
    message: string,
    kind: ErrorKind,
    options: { httpStatus?: number; details?: unknown; cause?: unknown; safeMessage?: string; code?: string } = {},
  ) {
    super(message);
    this.name = 'AppError';
    Object.setPrototypeOf(this, new.target.prototype);

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
        ...(value instanceof AppError && {
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

  static notFound(message: string, details?: unknown, code?: string) {
    return new AppError(message, 'domain', { httpStatus: 404, details, code });
  }

  static forbidden(message: string, details?: unknown, code?: string) {
    return new AppError(message, 'auth', { httpStatus: 403, details, code });
  }

  static badRequest(message: string, details?: unknown, code?: string) {
    return new AppError(message, 'validation', { httpStatus: 400, details, code });
  }

  static unprocessable(message: string, details?: unknown, code?: string) {
    return new AppError(message, 'validation', { httpStatus: 422, details, code });
  }

  static timeout(message: string, details?: unknown, code?: string) {
    return new AppError(message, 'timeout', { details, code });
  }

  static canceled(message: string, details?: unknown, code?: string) {
    return new AppError(message, 'canceled', { details, code });
  }

  static internal(message: string, cause?: unknown, details?: unknown, code?: string) {
    return new AppError(message, 'infra', { cause, details, code });
  }

  static upstream(message: string, cause?: unknown, details?: unknown, code?: string) {
    return new AppError(message, 'upstream', { cause, details, code });
  }

  static serviceUnavailable(message: string, cause?: unknown, details?: unknown, code?: string) {
    return new AppError(message, 'infra', { httpStatus: 503, cause, details, code });
  }

  static from(err: unknown, fallback = 'Internal error'): AppError {
    return err instanceof AppError ? err : AppError.internal((err as any)?.message ?? fallback, err);
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
