import pc from 'picocolors';

import { parseDebugInput } from './Parser';

export const DEBUG_CATEGORIES = ['auth', 'routes', 'errors', 'vite', 'network', 'ssr'] as const;
export type DebugCategory = (typeof DEBUG_CATEGORIES)[number];
export type DebugConfig = boolean | DebugCategory[] | ({ all?: boolean } & Partial<Record<DebugCategory, boolean>>);
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface BaseLogger {
  debug?(meta?: Record<string, unknown>, message?: string): void;
  info?(meta?: Record<string, unknown>, message?: string): void;
  warn?(meta?: Record<string, unknown>, message?: string): void;
  error?(meta?: Record<string, unknown>, message?: string): void;
  child?(context: Record<string, unknown>): BaseLogger;
}

export interface Logs extends BaseLogger {
  debug(meta?: unknown, message?: string): void;
  debug(category: DebugCategory, meta?: unknown, message?: string): void;

  info(meta?: unknown, message?: string): void;
  warn(meta?: unknown, message?: string): void;
  error(meta?: unknown, message?: string): void;

  child(context: Record<string, unknown>): Logs;
  isDebugEnabled(category: DebugCategory): boolean;
}

export class Logger implements Logs {
  private debugEnabled = new Set<DebugCategory>();
  private context: Record<string, unknown> = {};

  constructor(
    private config: {
      custom?: BaseLogger;
      context?: Record<string, unknown>;
      minLevel?: LogLevel;
      includeStack?: boolean | ((level: LogLevel) => boolean);
      includeContext?: boolean | ((level: LogLevel) => boolean);
      singleLine?: boolean;
    } = {},
  ) {
    if (config.context) this.context = { ...config.context };
  }

  child(context: Record<string, unknown>): Logger {
    const customChild = this.config.custom?.child?.(context) ?? this.config.custom;
    const child = new Logger({ ...this.config, custom: customChild, context: { ...this.context, ...context } });
    child.debugEnabled = new Set(this.debugEnabled);
    return child;
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

  isDebugEnabled(category: DebugCategory): boolean {
    return this.debugEnabled.has(category);
  }

  private shouldEmit(level: LogLevel): boolean {
    const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
    const minLevel = this.config.minLevel ?? 'info';

    return order[level] >= order[minLevel];
  }

  private shouldIncludeStack(level: LogLevel): boolean {
    const include = this.config.includeStack;

    if (include === undefined) return level === 'error' || (level === 'warn' && process.env.NODE_ENV !== 'production');

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
    if (process.env.NODE_ENV === 'production') return now.toISOString();

    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const millis = String(now.getMilliseconds()).padStart(3, '0');

    return `${hours}:${minutes}:${seconds}.${millis}`;
  }

  private emit(level: LogLevel, message: string, meta?: unknown, category?: DebugCategory): void {
    if (!this.shouldEmit(level)) return;

    const timestamp = this.formatTimestamp();

    const wantCtx =
      this.config.includeContext === undefined
        ? false
        : typeof this.config.includeContext === 'function'
          ? this.config.includeContext(level)
          : this.config.includeContext;

    const customSink = this.config.custom?.[level];

    const consoleFallback = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    const sink = customSink ?? consoleFallback;

    const merged = meta ?? {};
    const withCtx = wantCtx && Object.keys(this.context).length > 0 ? { context: this.context, ...merged } : merged;

    const finalMeta = this.shouldIncludeStack(level) ? withCtx : this.stripStacks(withCtx);
    const hasMeta = finalMeta && typeof finalMeta === 'object' ? Object.keys(finalMeta as any).length > 0 : false;

    const levelText = level.toLowerCase() + (category ? `:${category.toLowerCase()}` : '');
    const plainTag = `[${levelText}]`;
    const coloredTag = (() => {
      switch (level) {
        case 'debug':
          return pc.gray(plainTag);
        case 'info':
          return pc.cyan(plainTag);
        case 'warn':
          return pc.yellow(plainTag);
        case 'error':
          return pc.red(plainTag);
        default:
          return plainTag;
      }
    })();

    const tagForOutput = customSink ? plainTag : coloredTag;
    const formatted = `${timestamp} ${tagForOutput} ${message}`;

    if (this.config.singleLine && hasMeta && !customSink) {
      const metaStr = JSON.stringify(finalMeta).replace(/\n/g, '\\n');
      consoleFallback(`${formatted} ${metaStr}`);

      return;
    }

    if (customSink) {
      const obj = hasMeta ? (finalMeta as Record<string, unknown>) : {};
      customSink(obj, formatted);
    } else {
      hasMeta ? consoleFallback(formatted, finalMeta) : consoleFallback(formatted);
    }
  }

  info(meta?: unknown, message?: string): void {
    this.emit('info', message ?? '', meta);
  }

  warn(meta?: unknown, message?: string): void {
    this.emit('warn', message ?? '', meta);
  }

  error(meta?: unknown, message?: string): void {
    this.emit('error', message ?? '', meta);
  }

  debug(category: DebugCategory, meta?: unknown, message?: string): void {
    if (!this.debugEnabled.has(category)) return;

    this.emit('debug', message ?? '', meta, category);
  }
}

export function createLogger(opts?: {
  debug?: DebugConfig | string | boolean;
  custom?: BaseLogger;
  context?: Record<string, unknown>;
  minLevel?: LogLevel;
  includeStack?: boolean | ((level: LogLevel) => boolean);
  includeContext?: boolean | ((level: LogLevel) => boolean);
  singleLine?: boolean;
}): Logger {
  const logger = new Logger({
    custom: opts?.custom,
    context: opts?.context,
    minLevel: opts?.minLevel,
    includeStack: opts?.includeStack,
    includeContext: opts?.includeContext,
    singleLine: opts?.singleLine,
  });

  const parsed = parseDebugInput(opts?.debug);
  if (parsed !== undefined) logger.configure(parsed);

  return logger;
}
