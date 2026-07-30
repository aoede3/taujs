import { AppError, normaliseError } from './AppError';
import { InitialDataFailure } from './InitialDataFailure';

import type { BaseLogger } from '../logging/types';

type FastifyTerminal = {
  terminal: 'fastify';
  logger?: BaseLogger;
  error: unknown;
  method: string;
  url: string;
  route?: string;
};

type StreamingTerminal = {
  terminal: 'streaming';
  logger?: BaseLogger;
  error: unknown;
  url: string;
  clientRoot: string;
};

export type ResponseFailureLogContext = FastifyTerminal | StreamingTerminal;

const isExpectedInitialDataFailure = (error: InitialDataFailure): boolean => error.kind === 'domain' || error.kind === 'validation' || error.kind === 'auth';

const safeAppError = (error: unknown): AppError => {
  try {
    return AppError.from(error);
  } catch {
    return AppError.internal('Internal error');
  }
};

const safeNormaliseError = (error: unknown): ReturnType<typeof normaliseError> => {
  try {
    return normaliseError(error);
  } catch {
    return { name: 'Error', message: '[unstringifiable]' };
  }
};

/**
 * Emit the response-boundary failure record. It intentionally owns no conversion, recording or
 * teardown: callers continue those operations even when a logger is absent or throws.
 */
export const logResponseFailure = (context: ResponseFailureLogContext): void => {
  try {
    const { logger, error } = context;
    if (!logger) return;

    if (InitialDataFailure.is(error)) {
      const level = isExpectedInitialDataFailure(error) ? 'warn' : 'error';
      logger[level]?.(
        {
          component: 'fetch-initial-data',
          origin: error.origin,
          kind: error.kind,
          httpStatus: error.httpStatus,
          ...(error.code ? { code: error.code } : {}),
          ...(error.details ? { details: error.details } : {}),
          params: error.params,
          ...(level === 'error' ? { stack: error.stack } : {}),
          ...(context.terminal === 'fastify'
            ? { method: context.method, url: context.url, route: context.route }
            : { clientRoot: context.clientRoot, url: context.url }),
        },
        error.message,
      );
      return;
    }

    if (context.terminal === 'fastify') {
      const appError = safeAppError(error);
      logger.error?.(
        {
          kind: appError.kind,
          httpStatus: appError.httpStatus,
          ...(appError.code ? { code: appError.code } : {}),
          ...(appError.details ? { details: appError.details } : {}),
          method: context.method,
          url: context.url,
          route: context.route,
          stack: appError.stack,
        },
        appError.message,
      );
      return;
    }

    logger.error?.({ error: safeNormaliseError(error), clientRoot: context.clientRoot, url: context.url }, 'Critical rendering error during stream');
  } catch {
    // Logging is advisory. The caller must still convert, record and tear down the response.
  }
};
