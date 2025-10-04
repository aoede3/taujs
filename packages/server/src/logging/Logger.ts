import { randomUUID } from 'node:crypto';
import pc from 'picocolors';

import { noRedaction } from './utils';
import { parseDebugInput } from './Parser';

import type { Redactor } from './utils';
import type { DebugInput } from './Parser';

export const DEBUG_CATEGORIES = ['auth', 'routes', 'errors', 'vite', 'network'] as const;

export type DebugCategory = (typeof DEBUG_CATEGORIES)[number];

export type DebugConfig = boolean | DebugCategory[] | ({ all?: boolean } & Partial<Record<DebugCategory, boolean>>);
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type ObjectFirstSink = (obj: Record<string, unknown>) => void;
type MessageFirstSink = (message: string, meta?: unknown) => void;

export type CustomLogger = {
  debug?: ObjectFirstSink | MessageFirstSink;
  info?: ObjectFirstSink | MessageFirstSink;
  warn?: ObjectFirstSink | MessageFirstSink;
  error?: ObjectFirstSink | MessageFirstSink;
  log?: ObjectFirstSink | MessageFirstSink;
};

export type Logs = {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  debug(category: DebugCategory, message: string, meta?: unknown): void;
  child(context: Record<string, unknown>): Logs;
  configure(debug?: DebugConfig): void;
  isDebugEnabled(category: DebugCategory): boolean;
  enable(category: DebugCategory): void;
  disable(category: DebugCategory): void;
  setLevel(level: LogLevel): void;
};

export class Logger implements Logs {
  private debugEnabled = new Set<DebugCategory>();
  private context: Record<string, unknown> = {};
  private once = new Map<string, number>();
  private readonly maxOnceKeys: number;
  private readonly onceEvictRatio: number;
  private readonly onceTTLms: number;
  constructor(
    private config: {
      custom?: CustomLogger;
      redactor?: Redactor;
      context?: Record<string, unknown>;
      minLevel?: LogLevel;
      includeStack?: boolean | ((level: LogLevel) => boolean);
      includeContext?: boolean | ((level: LogLevel) => boolean);
      now?: () => string;
      onceMax?: number;
      onceEvictRatio?: number;
      onceTTLms?: number;
      objectFirst?: boolean;
    } = {},
  ) {
    if (config.context) this.context = { ...config.context };
    this.maxOnceKeys = config.onceMax ?? 10_000;
    this.onceEvictRatio = config.onceEvictRatio ?? 0.2;
    this.onceTTLms = config.onceTTLms ?? 0;
  }

  child(context: Record<string, unknown>): Logger {
    return new Logger({ ...this.config, context: { ...this.context, ...context } });
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

  scoped<T>(opts: { context?: Record<string, unknown>; redactor?: Redactor; minLevel?: LogLevel }, fn: (log: Logger) => T): T {
    const child = new Logger({ ...this.config, ...opts, context: { ...this.context, ...(opts.context || {}) } });
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

  enable(category: DebugCategory): void {
    this.debugEnabled.add(category);
  }

  disable(category: DebugCategory): void {
    this.debugEnabled.delete(category);
  }

  setLevel(level: LogLevel): void {
    (this.config as any).minLevel = level;
  }

  private shouldEmit(level: LogLevel): boolean {
    const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
    const minLevel = this.config.minLevel ?? 'info';
    return order[level] >= order[minLevel];
  }

  private shouldIncludeStack(level: LogLevel): boolean {
    const include = this.config.includeStack;
    if (include === undefined) {
      return level === 'error' || (level === 'warn' && process.env.NODE_ENV !== 'production');
    }
    if (typeof include === 'boolean') return include;
    return include(level);
  }

  private stripStacks(meta: unknown, seen = new WeakSet<object>()): unknown {
    if (!meta || typeof meta !== 'object') return meta;
    if (seen.has(meta as object)) return '[circular]';
    seen.add(meta as object);

    if (Array.isArray(meta)) return meta.map((v) => this.stripStacks(v, seen));

    const copy: Record<string, unknown> = { ...(meta as Record<string, unknown>) };
    for (const k of Object.keys(copy)) {
      if (k === 'stack' || k.endsWith('Stack')) {
        delete copy[k];
      } else {
        copy[k] = this.stripStacks(copy[k], seen);
      }
    }

    return copy;
  }

  private formatTimestamp(): string {
    const now = new Date();
    if (process.env.NODE_ENV === 'production') {
      return now.toISOString();
    }

    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const millis = String(now.getMilliseconds()).padStart(3, '0');

    return `${hours}:${minutes}:${seconds}.${millis}`;
  }

  private emit(level: LogLevel, message: string, meta?: unknown, category?: DebugCategory): void {
    if (!this.shouldEmit(level)) return;
    const timestamp = this.config.now ? this.config.now() : this.formatTimestamp();

    const wantCtx =
      this.config.includeContext === undefined
        ? false
        : typeof this.config.includeContext === 'function'
          ? this.config.includeContext(level)
          : this.config.includeContext;

    const customSink = this.config.custom?.[level] ?? (level === 'debug' ? this.config.custom?.info : undefined) ?? this.config.custom?.log;

    const consoleFallback = (...args: any[]) => (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(...args);
    const sink = customSink ?? consoleFallback;

    const merged = meta ?? {};
    const withCtx = wantCtx && Object.keys(this.context).length > 0 ? { context: this.context, ...merged } : merged;

    const redact = this.config.redactor ?? noRedaction;
    const redacted = ((): unknown => {
      if (!withCtx || typeof withCtx !== 'object') return withCtx;
      const walk = (v: unknown, seen = new WeakSet<object>()): unknown => {
        if (!v || typeof v !== 'object') return v;
        if (seen.has(v as object)) return '[circular]';
        seen.add(v as object);
        if (Array.isArray(v)) return v.map((x) => walk(x, seen));
        const out: Record<string, unknown> = {};
        for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
          out[k] = walk(redact(k, vv), seen);
        }
        return out;
      };
      return walk(withCtx);
    })();

    const finalMeta = this.shouldIncludeStack(level) ? redacted : this.stripStacks(redacted);
    const hasMeta = finalMeta && typeof finalMeta === 'object' ? Object.keys(finalMeta as any).length > 0 : false;

    const coloredLevel = (() => {
      const levelText = level.toLowerCase() + (category ? `:${category.toLowerCase()}` : '');
      switch (level) {
        case 'debug':
          return pc.gray(`[${levelText}]`);
        case 'info':
          return pc.cyan(`[${levelText}]`);
        case 'warn':
          return pc.yellow(`[${levelText}]`);
        case 'error':
          return pc.red(`[${levelText}]`);
        default:
          return `[${levelText}]`;
      }
    })();

    const formatted = `${timestamp} ${coloredLevel} ${message}`;

    const logObject: Record<string, unknown> = {
      ts: timestamp,
      level,
      message,
      ...(category && { category }),
      ...(hasMeta ? { meta: finalMeta } : {}),
    };

    const wantsObject = this.config.objectFirst !== undefined ? this.config.objectFirst : !!customSink && (customSink as Function).length <= 1;

    if (customSink) {
      if (wantsObject) (sink as (o: Record<string, unknown>) => void)(logObject);
      else if (hasMeta) (sink as (m: string, meta?: unknown) => void)(formatted, finalMeta);
      else (sink as (m: string) => void)(formatted);
    } else {
      if (hasMeta) consoleFallback(formatted, finalMeta);
      else consoleFallback(formatted);
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

  debug(category: DebugCategory, message: string, meta?: unknown): void {
    if (!this.debugEnabled.has(category)) return;
    this.emit('debug', message, meta, category);
  }

  private evictOldest(count: number): void {
    const iterator = this.once.keys();
    for (let i = 0; i < count; i++) {
      const result = iterator.next();
      if (result.done) break;
      this.once.delete(result.value);
    }
  }

  private purgeExpired(): void {
    if (!this.onceTTLms) return;
    const now = Date.now();
    for (const [key, expiresAt] of this.once) {
      if (expiresAt <= now) this.once.delete(key);
    }
  }

  debugOnce(key: string, category: DebugCategory, message: string, meta?: unknown): void {
    this.purgeExpired();
    const now = Date.now();

    if (this.onceTTLms) {
      const expiresAt = this.once.get(key);
      if (expiresAt !== undefined && expiresAt > now) return;
    } else {
      if (this.once.has(key)) return;
    }

    if (this.once.size >= this.maxOnceKeys) {
      const toRemove = Math.max(1, Math.floor(this.maxOnceKeys * this.onceEvictRatio));
      this.evictOldest(toRemove);
    }

    const expiresAt = this.onceTTLms ? now + this.onceTTLms : Number.POSITIVE_INFINITY;
    this.once.set(key, expiresAt);

    this.debug(category, message, meta);
  }

  isDebugEnabled(category: DebugCategory): boolean {
    return this.debugEnabled.has(category);
  }
}

export function createLogger(opts?: {
  debug?: DebugInput;
  custom?: CustomLogger;
  redactor?: Redactor;
  context?: Record<string, unknown>;
  minLevel?: LogLevel;
  includeStack?: boolean | ((level: LogLevel) => boolean);
  includeContext?: boolean | ((level: LogLevel) => boolean);
  now?: () => string;
  objectFirst?: boolean;
  onceMax?: number;
  onceEvictRatio?: number;
  onceTTLms?: number;
}): Logger {
  const logger = new Logger({
    custom: opts?.custom,
    redactor: opts?.redactor,
    context: opts?.context,
    minLevel: opts?.minLevel,
    includeStack: opts?.includeStack,
    includeContext: opts?.includeContext,
    now: opts?.now,
    objectFirst: opts?.objectFirst,
    onceMax: opts?.onceMax,
    onceEvictRatio: opts?.onceEvictRatio,
    onceTTLms: opts?.onceTTLms,
  });
  const parsed = parseDebugInput(opts?.debug);
  if (parsed !== undefined) logger.configure(parsed);

  return logger;
}

/**
 * Convenience helper for creating request-scoped child loggers.
 * Extracts requestId from common headers or generates one.
 *
 * Checks (in order):
 * - x-request-id
 * - x-correlation-id
 * - req.id (Fastify)
 * - Generated UUID
 *
 * @param base Base logger instance
 * @param req Request-like object with url, headers, and optional id
 * @param component Component name for context (default: 'request')
 */
export function requestChild(
  base: Logger,
  req: {
    url?: string;
    headers?: Record<string, string | string[] | undefined>;
    id?: string;
  },
  component = 'request',
): Logger {
  const first = (v?: string | string[]): string | undefined => (Array.isArray(v) ? v[0] : v);

  const requestId = first(req.headers?.['x-request-id']) ?? first(req.headers?.['x-correlation-id']) ?? req.id ?? randomUUID();

  return base.child({
    component,
    url: req.url,
    requestId,
  });
}
