export type UILogger = {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export type ServerLogs = {
  info: (meta?: unknown, message?: string) => void;
  warn: (meta?: unknown, message?: string) => void;
  error: (meta?: unknown, message?: string) => void;
  debug?: (category: string, meta?: unknown, message?: string) => void;
  child?: (ctx: Record<string, unknown>) => ServerLogs;
  isDebugEnabled?: (category: string) => boolean;
};

export type LoggerLike = Partial<UILogger> | Partial<ServerLogs>;

type Opts = {
  debugCategory?: string;
  context?: Record<string, unknown>;
  preferDebug?: boolean;
  enableDebug?: boolean;
};

// R0-03/gate: NON-THROWING value formatting. Renderer errors are `unknown`, and this runs on
// error paths that log BEFORE cleanup (see `createStreamController.fatalAbort`), so it must never
// throw — `JSON.stringify` alone would on a `BigInt`, a circular object, or a throwing
// `toJSON`/`Symbol.toPrimitive`. Falls back to a best-effort string that also cannot throw.
const toJSONString = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack ?? v.message;
  try {
    const json = JSON.stringify(v);
    if (json !== undefined) return json;
  } catch {
    // fall through to String() best-effort
  }
  try {
    return String(v);
  } catch {
    return '[unserializable]';
  }
};

const splitMsgAndMeta = (args: unknown[]) => {
  const [first, ...rest] = args;
  const msg = toJSONString(first);
  if (rest.length === 0) return { msg, meta: undefined };

  const only = rest.length === 1 ? rest[0] : undefined;
  const meta = only && typeof only === 'object' && !(only instanceof Error) ? only : { args: rest.map(toJSONString) };

  return { msg, meta };
};

// R0-03/gate: a diagnostic logger must never break the code path it observes (`fatalAbort` logs
// BEFORE cleanup). `safe` isolates BOTH value formatting and the user-provided logger method — a
// swallowed failure loses a log line, never settlement/cleanup. Documented policy: the UI logger
// is best-effort and non-throwing.
const safe = (fn: () => void): void => {
  try {
    fn();
  } catch {
    // best-effort: diagnostics must not throw
  }
};

export function createUILogger(logger?: LoggerLike, opts: Opts = {}): UILogger {
  const { debugCategory = 'ssr', context, preferDebug = false, enableDebug = false } = opts;

  // R0-03: `enableDebug` gates VERBOSITY (the `log` channel), not error visibility. `warn` and
  // `error` always route — to the provided logger if any, else `console`. Only `log` is gated,
  // so production consumers still see renderer warnings/errors (RFC S2).
  const looksServer = !!logger && ('info' in logger || 'debug' in logger || 'child' in logger || 'isDebugEnabled' in logger);

  if (looksServer) {
    let s = logger as Partial<ServerLogs>;

    if (s.child && context) {
      try {
        s = s.child.call(s as any, context);
      } catch {
        // ignore child failures; fall back to original
      }
    }

    const info = s.info
      ? (msg: string, meta?: unknown) => s.info!(meta, msg)
      : (msg: string, meta?: unknown) => (meta ? console.log(msg, meta) : console.log(msg));

    const warn = s.warn
      ? (msg: string, meta?: unknown) => s.warn!(meta, msg)
      : (msg: string, meta?: unknown) => (meta ? console.warn(msg, meta) : console.warn(msg));

    const error = s.error
      ? (msg: string, meta?: unknown) => s.error!(meta, msg)
      : (msg: string, meta?: unknown) => (meta ? console.error(msg, meta) : console.error(msg));

    const debug = s.debug ? (category: string, msg: string, meta?: unknown) => s.debug!(category, meta, msg) : undefined;

    const isDebugEnabled = s.isDebugEnabled ? (category: string) => s.isDebugEnabled!(category) : undefined;

    return {
      log: enableDebug
        ? (...args: unknown[]) =>
            safe(() => {
              const { msg, meta } = splitMsgAndMeta(args);

              if (debug) {
                const enabled = (isDebugEnabled ? isDebugEnabled(debugCategory) : false) || preferDebug;

                if (enabled) {
                  debug(debugCategory, msg, meta);
                  return;
                }
              }

              info(msg, meta);
            })
        : () => {},
      warn: (...args: unknown[]) =>
        safe(() => {
          const { msg, meta } = splitMsgAndMeta(args);
          warn(msg, meta);
        }),
      error: (...args: unknown[]) =>
        safe(() => {
          const { msg, meta } = splitMsgAndMeta(args);
          error(msg, meta);
        }),
    };
  }

  const ui = (logger as Partial<UILogger>) || {};
  return {
    log: enableDebug ? (...a) => safe(() => (ui.log ?? console.log)(...a)) : () => {},
    warn: (...a) => safe(() => (ui.warn ?? console.warn)(...a)),
    error: (...a) => safe(() => (ui.error ?? console.error)(...a)),
  };
}
