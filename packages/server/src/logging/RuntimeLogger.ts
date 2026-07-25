import { createLogger, type Logger } from './Logger';

import type { BaseLogger, DebugConfig, LogLevel } from '../core/logging/types';

export type RuntimeLoggerSource = 'explicit' | 'fastify' | 'fallback';

export type RuntimeLoggerSelection = Readonly<{
  source: RuntimeLoggerSource;
  custom?: BaseLogger;
  debug?: DebugConfig;
  minLevel: LogLevel;
}>;

type RuntimeLoggerOptions = {
  context?: Record<string, unknown>;
  includeStack?: boolean | ((level: LogLevel) => boolean);
  includeContext?: boolean | ((level: LogLevel) => boolean);
  singleLine?: boolean;
};

/**
 * Create one τjs logger node from the runtime-selected sink.
 *
 * A custom child owns its bindings. When no child seam exists, the τjs wrapper
 * retains the context so plain BaseLogger implementations receive equivalent
 * structured metadata.
 */
export const createRuntimeLogger = (selection: RuntimeLoggerSelection, options: RuntimeLoggerOptions = {}): Logger => {
  const customChild = options.context ? selection.custom?.child?.(options.context) : undefined;

  return createLogger({
    debug: selection.debug,
    custom: customChild ?? selection.custom,
    context: customChild ? undefined : options.context,
    minLevel: selection.minLevel,
    includeStack: options.includeStack,
    includeContext: options.includeContext,
    singleLine: options.singleLine,
  });
};
