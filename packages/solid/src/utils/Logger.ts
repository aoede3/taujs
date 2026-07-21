/**
 * Logger adapter. Deliberately NOT a drift-copy of `@taujs/react/src/utils/Logger.ts`: the frozen
 * public API (design 1.5) names `ServerLogger`, where React's names `ServerLogs`, so this follows
 * the DESIGN rather than the upstream file.
 *
 * The one property that IS carried across deliberately - because it is sound and this package
 * needs it - is that formatting NEVER THROWS. This runs on error paths that log BEFORE cleanup, so
 * a throwing formatter would break the very control flow it is observing.
 */

export type UILogger = {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export type ServerLogger = {
  info: (meta?: unknown, message?: string) => void;
  warn: (meta?: unknown, message?: string) => void;
  error: (meta?: unknown, message?: string) => void;
  debug?: (category: string, meta?: unknown, message?: string) => void;
  child?: (ctx: Record<string, unknown>) => ServerLogger;
  isDebugEnabled?: (category: string) => boolean;
};

export type SolidLogger = Partial<UILogger> | Partial<ServerLogger>;

export type LogFns = {
  log: (message: string, extra?: unknown) => void;
  warn: (message: string, extra?: unknown) => void;
  error: (message: string, extra?: unknown) => void;
};

type Options = {
  debugCategory?: string;
  context?: Record<string, unknown>;
  enableDebug?: boolean;
};

/**
 * Format a value without ever throwing.
 *
 * NOTE - and this is deliberate, not an oversight: `@taujs/react` and `@taujs/vue`'s STORE
 * normalisers (`normaliseError`) fall back to an unguarded `String(v)` and therefore CAN throw on a
 * hostile `Symbol.toPrimitive`/`toString`. That defect is recorded in `decisions.md` as a separate
 * follow-up for those packages and is deliberately NOT fixed from here - fixing it would create a
 * behavioural parity difference beyond ESC-3, which needs its own ruling. This function is total,
 * so @taujs/solid does not inherit the defect.
 */
const format = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;

  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // circular, BigInt, or a throwing toJSON - fall through
  }

  try {
    return String(value);
  } catch {
    // hostile Symbol.toPrimitive / toString
  }

  return '[unserialisable value]';
};

const NOOP = () => {};

const isServerLogger = (logger: SolidLogger): logger is Partial<ServerLogger> =>
  typeof (logger as Partial<ServerLogger>).info === 'function' || typeof (logger as Partial<ServerLogger>).debug === 'function';

/**
 * Adapt either logger shape to one non-throwing call surface. A throwing user logger is swallowed:
 * a diagnostic must never break the path it observes (this is called from terminal handlers and
 * from writable event listeners, where a throw becomes an `uncaughtException`).
 */
export function createUILogger(logger: SolidLogger | undefined, options: Options = {}): LogFns {
  const { debugCategory = 'ssr', context, enableDebug = false } = options;

  if (!logger) return { log: NOOP, warn: NOOP, error: NOOP };

  const guard =
    (fn: (message: string, extra?: unknown) => void) =>
    (message: string, extra?: unknown): void => {
      try {
        fn(message, extra);
      } catch {
        // a throwing logger must not propagate
      }
    };

  if (isServerLogger(logger)) {
    const server = logger;
    const meta = (extra?: unknown) => ({ ...(context ?? {}), ...(extra !== undefined ? { detail: format(extra) } : {}) });

    return {
      log: guard((message, extra) => {
        if (!enableDebug) return;
        if (server.debug && (server.isDebugEnabled?.(debugCategory) ?? true)) server.debug(debugCategory, meta(extra), message);
        else server.info?.(meta(extra), message);
      }),
      warn: guard((message, extra) => server.warn?.(meta(extra), message)),
      error: guard((message, extra) => server.error?.(meta(extra), message)),
    };
  }

  const ui = logger as Partial<UILogger>;
  const args = (message: string, extra?: unknown) => (extra !== undefined ? [message, format(extra)] : [message]);

  return {
    log: guard((message, extra) => {
      if (enableDebug) ui.log?.(...args(message, extra));
    }),
    warn: guard((message, extra) => ui.warn?.(...args(message, extra))),
    error: guard((message, extra) => ui.error?.(...args(message, extra))),
  };
}
