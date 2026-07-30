import { AppError } from './AppError';

import type { RouteParams } from '../config/types';

/**
 * Internal boundary error for failures resolving `attr.data`.
 *
 * Data resolution owns classification. Response terminals recognise this type to emit the one
 * response-failure record with the route parameters that led to it. The class stays inside the
 * server package: it is not an application-facing error contract.
 */
export class InitialDataFailure extends AppError {
  readonly origin = 'attr.data' as const;
  readonly params: RouteParams;

  constructor(classified: AppError, params: RouteParams) {
    super(classified.message, classified.kind, {
      httpStatus: classified.httpStatus,
      details: classified.details,
      safeMessage: classified.safeMessage,
      code: classified.code,
      cause: (classified as Error & { cause?: unknown }).cause,
    });
    this.name = 'InitialDataFailure';
    this.params = params;
    this.stack = classified.stack;
  }

  static is(value: unknown): value is InitialDataFailure {
    return value instanceof InitialDataFailure;
  }
}
