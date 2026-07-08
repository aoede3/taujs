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

const toJSONString = (v: unknown) => (typeof v === 'string' ? v : v instanceof Error ? (v.stack ?? v.message) : JSON.stringify(v));

const splitMsgAndMeta = (args: unknown[]) => {
  const [first, ...rest] = args;
  const msg = toJSONString(first);
  if (rest.length === 0) return { msg, meta: undefined };

  const only = rest.length === 1 ? rest[0] : undefined;
  const meta = only && typeof only === 'object' && !(only instanceof Error) ? only : { args: rest.map(toJSONString) };

  return { msg, meta };
};

export function createUILogger(logger?: LoggerLike, opts: Opts = {}): UILogger {
  const { debugCategory = 'ssr', context, preferDebug = false, enableDebug = false } = opts;

  if (!enableDebug) {
    return {
      log: () => {},
      warn: () => {},
      error: () => {},
    };
  }

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
      log: (...args: unknown[]) => {
        const { msg, meta } = splitMsgAndMeta(args);

        if (debug) {
          const enabled = (isDebugEnabled ? isDebugEnabled(debugCategory) : false) || preferDebug;

          if (enabled) {
            debug(debugCategory, msg, meta);
            return;
          }
        }

        info(msg, meta);
      },
      warn: (...args: unknown[]) => {
        const { msg, meta } = splitMsgAndMeta(args);
        warn(msg, meta);
      },
      error: (...args: unknown[]) => {
        const { msg, meta } = splitMsgAndMeta(args);
        error(msg, meta);
      },
    };
  }

  const ui = (logger as Partial<UILogger>) || {};
  return {
    log: (...a) => (ui.log ?? console.log)(...a),
    warn: (...a) => (ui.warn ?? console.warn)(...a),
    error: (...a) => (ui.error ?? console.error)(...a),
  };
}
