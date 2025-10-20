export type UILogger = {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export type ServerLogs = {
  info: (message: string, meta?: unknown) => void;
  warn: (message: string, meta?: unknown) => void;
  error: (message: string, meta?: unknown) => void;
  debug?: (category: string, message: string, meta?: unknown) => void;
  child?: (ctx: Record<string, unknown>) => ServerLogs;
  isDebugEnabled?: (category: string) => boolean;
};

export type LoggerLike = Partial<UILogger> | Partial<ServerLogs>;

type Opts = { debugCategory?: string; context?: Record<string, unknown>; preferDebug?: boolean; enableDebug?: boolean };

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

  if (!enableDebug) return { log: () => {}, warn: () => {}, error: () => {} };

  const looksServer = !!logger && ('info' in logger || 'debug' in logger || 'child' in logger || 'isDebugEnabled' in logger);

  if (looksServer) {
    let s = logger as Partial<ServerLogs>;

    if (s.child && context) {
      try {
        s = s.child.call(s as any, context);
      } catch {}
    }

    const info = s.info ? s.info.bind(s) : (m: string, meta?: unknown) => (meta ? console.log(m, meta) : console.log(m));
    const warn = s.warn ? s.warn.bind(s) : (m: string, meta?: unknown) => (meta ? console.warn(m, meta) : console.warn(m));
    const error = s.error ? s.error.bind(s) : (m: string, meta?: unknown) => (meta ? console.error(m, meta) : console.error(m));

    const debug = s.debug ? s.debug.bind(s) : undefined;
    const isDebugEnabled = s.isDebugEnabled ? s.isDebugEnabled.bind(s) : undefined;

    return {
      log: (...args: unknown[]) => {
        const { msg, meta } = splitMsgAndMeta(args);

        if (debug) {
          const enabled = (isDebugEnabled ? isDebugEnabled(debugCategory) : false) || preferDebug;
          if (enabled) {
            debug(debugCategory, msg, meta);
            return;
          }
          // debug exists but not enabled → fall back to info
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

  // UI-shaped fallback: pass through to provided methods or console
  const ui = (logger as Partial<UILogger>) || {};
  return {
    log: (...a) => (ui.log ?? console.log)(...a),
    warn: (...a) => (ui.warn ?? console.warn)(...a),
    error: (...a) => (ui.error ?? console.error)(...a),
  };
}
