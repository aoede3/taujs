import pc from 'picocolors';

import { normaliseServiceError, logServiceError } from './ServiceError';
import { DEBUG } from '../constants';

export type CSPViolationReport = {
  'document-uri': string;
  'violated-directive': string;
  'blocked-uri': string;
  'source-file'?: string;
  'line-number'?: number;
  'column-number'?: number;
  'script-sample'?: string;
  'original-policy': string;
  disposition: 'enforce' | 'report';
};

// ============================================================================
// RUNTIME-AGNOSTIC ERROR & LOGGING
// Production-hardened with cross-runtime support
// ============================================================================

// ============================================================================
// ERROR HANDLING
// ============================================================================

const DEBUG_CATEGORIES = ['auth', 'routes', 'errors', 'vite', 'network'] as const;
export type DebugCategory = (typeof DEBUG_CATEGORIES)[number];

export type ErrorKind = 'infra' | 'upstream' | 'domain' | 'validation' | 'auth' | 'canceled' | 'timeout';

export type DebugInput =
  | DebugConfig // your existing shape
  | string // "auth,routes,-vite"
  | boolean // true/false = all on/off
  | undefined;

function parseDebugInput(input: DebugInput): DebugConfig | undefined {
  if (input === undefined) return undefined;
  if (typeof input === 'boolean') return input;

  if (typeof input === 'string') {
    const raw = input.trim();
    if (!raw) return undefined;
    if (raw === '*' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'all') return true;

    const parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // support +tag / -tag toggles; unknown tags are ignored
    const flags: { all?: boolean } & Partial<Record<DebugCategory, boolean>> = {};
    for (const p of parts) {
      const neg = p.startsWith('-') || p.startsWith('!');
      const key = (neg ? p.slice(1) : p) as DebugCategory;
      if ((DEBUG_CATEGORIES as readonly string[]).includes(key)) {
        flags[key] = !neg;
      }
    }
    return flags;
  }

  // Already a DebugConfig
  return input;
}

const HTTP_STATUS: Record<ErrorKind, number> = {
  infra: 500, // Internal Server Error
  upstream: 502, // Bad Gateway
  domain: 404, // Not Found
  validation: 400, // Bad Request (use 422 via factory for semantic validation)
  auth: 403, // Forbidden
  canceled: 499, // Client Closed Request (NGINX convention)
  timeout: 504, // Gateway Timeout
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
    options: {
      httpStatus?: number;
      details?: unknown;
      cause?: unknown;
      safeMessage?: string;
      code?: string;
    } = {},
  ) {
    // Use native cause support when available (cast for older TS lib targets)
    super(message, options.cause ? ({ cause: options.cause } as any) : undefined);
    this.name = 'AppError';

    // Fix prototype chain for proper instanceof checks (only needed for ES5 targets)
    Object.setPrototypeOf(this, new.target.prototype);

    this.kind = kind;
    this.httpStatus = options.httpStatus ?? HTTP_STATUS[kind];
    this.details = options.details;
    this.safeMessage = options.safeMessage ?? this.getSafeMessage(kind, message);
    this.code = options.code;

    // Ensure cause is set even on older targets that don't support ErrorOptions
    if (options.cause && (this as any).cause === undefined) {
      (this as any).cause = options.cause;
    }

    // Capture stack trace where available
    if ((Error as any).captureStackTrace) {
      (Error as any).captureStackTrace(this, AppError);
    }
  }

  private getSafeMessage(kind: ErrorKind, message: string): string {
    // Only expose domain/validation/auth errors to clients
    return kind === 'domain' || kind === 'validation' || kind === 'auth' ? message : 'Internal Server Error';
  }

  toJSON() {
    return {
      name: this.name,
      kind: this.kind,
      message: this.message,
      safeMessage: this.safeMessage,
      httpStatus: this.httpStatus,
      ...(this.code && { code: this.code }),
      details: this.details,
      stack: this.stack,
    };
  }

  // Factories
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

// Status helpers
export function httpStatusFrom(err: unknown, fallback = 500): number {
  return err instanceof AppError ? err.httpStatus : fallback;
}

export function statusText(status: number): string {
  const map: Record<number, string> = {
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
  };
  return map[status] ?? 'Error';
}

// ============================================================================
// REDACTION & SMALL HELPERS (declared before any usage)
// ============================================================================

export type Redactor = (key: string, value: unknown) => unknown;
export const noRedaction: Redactor = (_key, value) => value;

export const composeRedactors =
  (...redactors: Redactor[]): Redactor =>
  (key, value) =>
    redactors.reduce((acc, r) => r(key, acc), value);

export const maskKeys =
  (keys: (string | RegExp)[], mask = '[REDACTED]'): Redactor =>
  (key, value) =>
    keys.some((p) => (typeof p === 'string' ? key === p : p.test(key))) ? mask : value;

// Allow-list projection
export const pick = <T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> =>
  keys.reduce((acc, key) => ((acc[key] = obj[key]), acc), {} as Pick<T, K>);

// HTTP body helper (maps canceled 499 -> 408 externally)
export function toHttp(err: unknown): { status: number; body: Record<string, unknown> } {
  const app = AppError.from(err);
  let status = httpStatusFrom(app);
  let errorMessage = app.safeMessage;

  if (app.kind === 'canceled') {
    status = 408;
    errorMessage = 'Request timeout';
  }

  return {
    status,
    body: {
      error: errorMessage,
      ...(app.code && { code: app.code }),
      statusText: statusText(status),
    },
  };
}

// Safe client error shape
export function toClientError(err: unknown): { error: string; code?: string } {
  const app = AppError.from(err);
  return { error: app.safeMessage, ...(app.code && { code: app.code }) };
}

// Exhaustiveness/assert helper
function assertNever(x: never): never {
  throw new Error(`Unreachable: ${x}`);
}

// Classify error kind into client/server buckets
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
      return assertNever(kind);
  }
}

// Lightweight duration timer
export function startTimer(): () => number {
  const t0 = Date.now();
  return () => Date.now() - t0;
}

// ============================================================================
// LOGGING
// ============================================================================

export type DebugConfig = boolean | DebugCategory[] | ({ all?: boolean } & Partial<Record<DebugCategory, boolean>>);

export type LogLevel = 'info' | 'warn' | 'error';

export interface CustomLogger {
  info?: (message: string, meta?: unknown) => void;
  warn?: (message: string, meta?: unknown) => void;
  error?: (message: string, meta?: unknown) => void;
  // Legacy support
  log?: (message: string, meta?: unknown) => void;
}

// Structured, safe serializer (used only for console fallback if desired)
function safeSerialize(value: unknown, redactor: Redactor = noRedaction, maxDepth = 6, maxLen = 100_000): string {
  const seen = new WeakSet<object>();

  function normalize(v: unknown, depth: number): unknown {
    if (depth > maxDepth) return '[DepthLimit]';

    if (v instanceof Error) {
      const cause = (v as any).cause;
      return {
        name: v.name,
        message: v.message,
        stack: v.stack,
        ...(cause && {
          cause: cause instanceof Error ? { name: cause.name, message: cause.message, stack: cause.stack } : '[Non-Error cause]',
        }),
      };
    }

    if (typeof v === 'bigint') return v.toString();

    if (v && typeof v === 'object') {
      if (seen.has(v as object)) return '[Circular]';
      seen.add(v as object);

      if (Array.isArray(v)) {
        return v.map((item, i) => normalize(redactor(String(i), item), depth + 1));
      }

      const out: Record<string, unknown> = {};
      for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
        out[k] = normalize(redactor(k, raw), depth + 1);
      }
      return out;
    }

    return v;
  }

  try {
    const normalized = normalize(value, 0);
    let s = JSON.stringify(normalized);
    if (s && s.length > maxLen) s = s.slice(0, maxLen) + '…[Truncated]';
    return s ?? '';
  } catch (err) {
    return `[Serialization Error: ${(err as Error).message}]`;
  }
}

export type Logs = {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  child(context: Record<string, unknown>): Logs;
  configure(debug?: DebugConfig): void;
};

export class Logger implements Logs {
  private debugEnabled = new Set<DebugCategory>();
  private context: Record<string, unknown> = {};
  private once = new Set<string>();
  private readonly maxOnceKeys = 10_000;

  constructor(
    private config: {
      custom?: CustomLogger;
      redactor?: Redactor;
      context?: Record<string, unknown>;
      minLevel?: LogLevel;
      includeStack?: boolean | ((level: LogLevel) => boolean);
      includeContext?: boolean | ((level: LogLevel) => boolean);
    } = {},
  ) {
    if (config.context) {
      this.context = { ...config.context };
    }
  }

  // Children & context
  child(context: Record<string, unknown>): Logger {
    return new Logger({
      ...this.config,
      context: { ...this.context, ...context },
    });
  }

  setContext(patch: Record<string, unknown>): void {
    this.context = { ...this.context, ...patch };
  }
  clearContext(): void {
    this.context = {};
  }

  withContext(ctx: Record<string, unknown>, fn: () => void): void {
    const prev = this.context;
    try {
      this.setContext(ctx);
      fn();
    } finally {
      this.context = prev;
    }
  }

  scoped<T>(
    opts: {
      context?: Record<string, unknown>;
      redactor?: Redactor;
      minLevel?: LogLevel;
    },
    fn: (log: Logger) => T,
  ): T {
    const child = new Logger({
      ...this.config,
      ...opts,
      context: { ...this.context, ...(opts.context || {}) },
    });
    return fn(child);
  }

  resetDebugOnce(): void {
    this.once.clear();
  }

  configure(debug?: DebugConfig): void {
    this.debugEnabled.clear();

    if (debug === true) {
      this.debugEnabled = new Set(DEBUG_CATEGORIES);
    } else if (Array.isArray(debug)) {
      this.debugEnabled = new Set(debug);
    } else if (typeof debug === 'object' && debug) {
      if (debug.all) this.debugEnabled = new Set(DEBUG_CATEGORIES);
      Object.entries(debug).forEach(([key, value]) => {
        if (key !== 'all' && typeof value === 'boolean') {
          if (value) this.debugEnabled.add(key as DebugCategory);
          else this.debugEnabled.delete(key as DebugCategory);
        }
      });
    }
  }

  private shouldEmit(level: LogLevel): boolean {
    const order: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };
    const minLevel = this.config.minLevel ?? 'info';
    return order[level] >= order[minLevel];
  }

  private shouldIncludeStack(level: LogLevel, meta?: unknown): boolean {
    const include = this.config.includeStack;

    if (include === undefined) return level === 'error';
    if (typeof include === 'boolean') return include;
    return include(level);
  }

  private stripStacks(meta: unknown, seen = new WeakSet<object>()): unknown {
    if (!meta || typeof meta !== 'object') return meta;
    if (seen.has(meta as object)) return meta;
    seen.add(meta as object);

    if (Array.isArray(meta)) return meta.map((v) => this.stripStacks(v, seen));

    const copy: Record<string, unknown> = { ...(meta as Record<string, unknown>) };
    for (const k of Object.keys(copy)) {
      if (k === 'stack' || k.endsWith('Stack')) {
        delete copy[k];
      } else if (copy[k] && typeof copy[k] === 'object') {
        copy[k] = this.stripStacks(copy[k], seen);
      }
    }
    return copy;
  }

  private emit(level: LogLevel, message: string, meta?: unknown): void {
    if (!this.shouldEmit(level)) return;

    const timestamp = new Date().toISOString();
    const wantCtx =
      this.config.includeContext === undefined
        ? false
        : typeof this.config.includeContext === 'function'
          ? this.config.includeContext(level)
          : this.config.includeContext;

    const mergedBase = meta ?? {};
    const merged = wantCtx ? { ...this.context, ...mergedBase } : mergedBase;
    const finalMeta = this.shouldIncludeStack(level, merged) ? merged : this.stripStacks(merged);
    const hasMeta = Object.keys(finalMeta as Record<string, unknown>).length > 0;

    const formatted = `${timestamp} [${level.toUpperCase()}] ${message}`;

    // Prefer custom structured sinks; otherwise fall back to console
    const customSink = this.config.custom?.[level] ?? this.config.custom?.log;
    const consoleFallback = (...args: any[]) => {
      (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(...args);
    };
    const sink = customSink ?? consoleFallback;

    if (hasMeta) {
      // Pass structured meta (better for most vendor SDKs). Console fallback gets objects too.
      sink(formatted, finalMeta);
    } else {
      sink(formatted);
    }
  }

  info(message: string, meta?: unknown): void {
    this.emit('info', message, meta);
  }
  warn(message: string, meta?: unknown): void {
    this.emit('warn', message, meta);
  }
  error(message: string, meta?: unknown): void {
    this.emit('error', message, meta);
  }

  // Debug with categories (emits via info/log level sink)
  debug(category: DebugCategory, message: string, meta?: unknown): void {
    if (!this.debugEnabled.has(category)) return;

    const timestamp = new Date().toISOString();
    const merged = meta ? { ...this.context, ...meta } : this.context;
    const hasMeta = Object.keys(merged).length > 0;

    const formatted = `${timestamp} [${category}] ${message}`;

    const customSink = this.config.custom?.info ?? this.config.custom?.log;
    const sink = customSink ?? ((...args: any[]) => console.log(...args));

    if (hasMeta) sink(formatted, merged);
    else sink(formatted);
  }

  debugOnce(key: string, category: DebugCategory, message: string, meta?: unknown): void {
    if (this.once.size >= this.maxOnceKeys) this.once.clear();
    if (this.once.has(key)) return;
    this.once.add(key);
    this.debug(category, message, meta);
  }

  isDebugEnabled(category: DebugCategory): boolean {
    return this.debugEnabled.has(category);
  }

  fail(err: unknown, context?: Record<string, unknown>): never {
    const appError = AppError.from(err);

    this.error(appError.message, {
      kind: appError.kind,
      httpStatus: appError.httpStatus,
      safeMessage: appError.safeMessage,
      details: appError.details,
      ...context,
    });

    throw appError;
  }

  toLogObject(level: LogLevel, message: string, meta?: Record<string, unknown>): Record<string, unknown> {
    return {
      ts: new Date().toISOString(),
      level,
      message,
      ...(meta ? { meta } : {}),
    };
  }
}

export function createLogger(opts?: {
  debug?: DebugInput; // NEW: booleans, strings, or your DebugConfig
  custom?: CustomLogger;
  redactor?: Redactor;
  context?: Record<string, unknown>;
  minLevel?: LogLevel;
  includeStack?: boolean | ((level: LogLevel) => boolean);
  includeContext?: boolean | ((level: LogLevel) => boolean);
}): Logger {
  const logger = new Logger({
    custom: opts?.custom,
    redactor: opts?.redactor,
    context: opts?.context,
    minLevel: opts?.minLevel,
    includeStack: opts?.includeStack,
    includeContext: opts?.includeContext,
  });

  const parsed = parseDebugInput(opts?.debug ?? (typeof process !== 'undefined' ? (process.env.DEBUG as string | undefined) : undefined));

  if (parsed !== undefined) {
    logger.configure(parsed);
  }

  return logger;
}

// Handy helper for request-scoped loggers (optional)
export function withRequestContext(
  base: Logger,
  req: { headers?: Record<string, unknown>; url?: string; id?: string } & Record<string, any>,
  extra?: Record<string, unknown>,
  component: string = 'renderer',
): Logger {
  const requestId = (req?.headers?.['x-request-id'] as string) || (req?.headers?.['x-requestid'] as string) || (req as any)?.id || (req as any)?.requestId;

  return base.child({
    component,
    url: req?.url,
    requestId,
    ...(extra ?? {}),
  });
}

// ============================================================================
// SINGLETON & ENV CONFIG
// ============================================================================

// export const Log = new Logger();

// export function configureFromEnv(debugEnv?: string): void {
//   if (!debugEnv) return;

//   const value = debugEnv.trim().toLowerCase();
//   if (value === '*' || value === 'true') {
//     Log.configure(true);
//   } else if (value) {
//     const CAT = DEBUG_CATEGORIES as readonly DebugCategory[];
//     const categories = value
//       .split(',')
//       .map((s) => s.trim())
//       .filter((s): s is DebugCategory => (CAT as readonly string[]).includes(s));
//     Log.configure(categories);
//   }
// }

// ============================================================================
// OPTIONAL: PINO ADAPTER (external integration helper)
// ============================================================================

export function pinoAdapter(pino: any, baseCtx?: Record<string, unknown>): CustomLogger {
  const logger = pino.child(baseCtx ?? {});
  return {
    info: (msg, meta) => logger.info(meta ?? {}, msg),
    warn: (msg, meta) => logger.warn(meta ?? {}, msg),
    error: (msg, meta) => logger.error(meta ?? {}, msg),
  };
}

// export type Logger = {
//   log: (...args: unknown[]) => void;
//   warn: (...args: unknown[]) => void;
//   error: (...args: unknown[]) => void;
//   serviceError: (err: unknown, context?: Record<string, unknown>) => never;
//   cspViolation: (report: CSPViolationReport, context?: Record<string, unknown>) => void;
// };

// export type DebugCategory = keyof typeof DEBUG;
// export type DebugColour = (typeof DEBUG)[keyof typeof DEBUG]['colour'];
// export type DebugConfig = boolean | Partial<Record<DebugCategory, boolean>> | ({ all: boolean } & Partial<Record<DebugCategory, boolean>>);

// export const createLogger = (debug: DebugConfig = false, custom?: Partial<Logger>): Logger => {
//   const config = normaliseDebug(debug);

//   const base = {
//     log: (...args: unknown[]) => {
//       if (Object.values(config).some(Boolean)) (custom?.log ?? console.log)(...args);
//     },
//     warn: (...args: unknown[]) => (custom?.warn ?? console.warn)(...args),
//     error: (...args: unknown[]) => (custom?.error ?? console.error)(...args),
//   };

//   const serviceError = (err: unknown, context: Record<string, unknown> = {}): never => {
//     const se = normaliseServiceError(err, 'infra');
//     logServiceError(base, se);
//     base.error(pc.red('Service failure'), { ...context, error: se });

//     throw se;
//   };

//   const cspViolation = (report: CSPViolationReport, context: Record<string, unknown> = {}): void => {
//     if (config.csp || config.security) {
//       const directive = pc.red(report['violated-directive']);
//       const uri = pc.yellow(report['document-uri']);
//       const blocked = pc.cyan(report['blocked-uri']);
//       const tag = DEBUG.csp.colour('[csp]');
//       base.warn(`${tag} blocked ${blocked} (${directive}) on ${uri}`);
//     }

//     if (custom?.cspViolation) custom.cspViolation(report, context);
//   };

//   return { ...base, serviceError, cspViolation };
// };

// export const normaliseDebug = (config: DebugConfig | undefined): Record<DebugCategory, boolean> => {
//   const allOff = Object.fromEntries(Object.keys(DEBUG).map((k) => [k, false])) as Record<DebugCategory, false>;
//   const allOn = Object.fromEntries(Object.keys(DEBUG).map((k) => [k, true])) as Record<DebugCategory, true>;

//   if (config === undefined) return { ...allOff, errors: true };

//   if (typeof config === 'boolean') return Object.fromEntries(Object.keys(allOn).map((k) => [k, config])) as Record<DebugCategory, boolean>;

//   if ('all' in config) {
//     const base = Object.fromEntries(Object.keys(allOn).map((k) => [k, config.all])) as Record<DebugCategory, boolean>;
//     return { ...base, ...config };
//   }

//   return { ...allOn, ...config };
// };

// export const debugLog = (logger: Logger, category: DebugCategory, message: string, debug?: DebugConfig, req?: { method?: string; url?: string }) => {
//   if (debug === undefined) return;

//   const cfg = normaliseDebug(debug);
//   if (!cfg[category]) return;

//   const ts = pc.gray(new Date().toLocaleTimeString());
//   const color = DEBUG[category].colour;
//   const tag = color(`[${category}]`);

//   const parts = [ts, tag, message];

//   if (req?.method && req?.url) {
//     parts.push(`${req.method} ${req.url}`);
//   } else if (req?.url) {
//     parts.push(req.url);
//   }

//   logger.log(parts.join(' '));
// };
