import { AppError } from '../AppError';

import type { ErrorKind } from '../AppError';

export const httpStatusFrom = (err: unknown, fallback = 500): number => (err instanceof AppError ? err.httpStatus : fallback);

export const toHttp = (err: unknown): { status: number; body: Record<string, unknown> } => {
  const app = AppError.from(err);
  const status = httpStatusFrom(app);
  const errorMessage = app.safeMessage;
  return {
    status,
    body: {
      error: errorMessage,
      ...(app.code && { code: app.code }),
      statusText: statusText(status),
    },
  };
};

export function toClientError(err: unknown): { error: string; code?: string } {
  const app = AppError.from(err);
  return { error: app.safeMessage, ...(app.code && { code: app.code }) };
}

export function statusText(status: number): string {
  const map = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    408: 'Request Timeout',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    499: 'Client Closed Request',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
  } as const satisfies Record<number, string>;
  return map[status as keyof typeof map] ?? 'Error';
}

export function errorCategory(kind: ErrorKind): 'client' | 'server' {
  switch (kind) {
    case 'domain':
    case 'validation':
    case 'auth':
      return 'client';
    case 'infra':
    case 'upstream':
    case 'timeout':
    case 'canceled':
      return 'server';
    default:
      throw new Error(`Unreachable: ${kind}`);
  }
}
