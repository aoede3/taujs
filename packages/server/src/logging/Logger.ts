import pc from 'picocolors';

import { parseDebugInput } from './Parser';
import { redactDeniedKeys } from './Redaction';
import { runtimeMode } from '../System';
import { DEBUG_CATEGORIES, type BaseLogger, type DebugCategory, type DebugConfig, type Logs, type LogLevel } from '../core/logging/types';

export { DEBUG_CATEGORIES };
export type { DebugCategory, DebugConfig, Logs, BaseLogger, LogLevel };

/** Redact to a plain record; a root the walker replaced with a marker survives as { value }. */
const toSafeRecord = (value: unknown, stripStackKeys: boolean): Record<string, unknown> => {
  const redacted = redactDeniedKeys(value, undefined, { stripStackKeys });
  return redacted && typeof redacted === 'object' && !Array.isArray(redacted) ? (redacted as Record<string, unknown>) : { value: redacted };
};

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
    // Caller-owned context is walked by the guarded traversal BEFORE anything reads it - a spread
    // here would execute its getters unguarded. Stored context is therefore always a safe record.
    if (config.context) this.context = toSafeRecord(config.context, false);
  }

  child(context: Record<string, unknown>): Logger {
    // Caller context is redacted through the guarded walk BEFORE merging - spreading it raw would
    // execute its getters unguarded. The external child seam RETAINS its bindings (a pino-style
    // sink keeps them verbatim), so what it receives is the already-safe merged record.
    const mergedContext = { ...this.context, ...toSafeRecord(context, false) };
    const customChild = this.config.custom?.child?.(mergedContext);
    const child = new Logger({
      ...this.config,
      custom: customChild ?? this.config.custom,
      context: customChild ? {} : mergedContext,
    });
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

    if (include === undefined) return level === 'error' || (level === 'warn' && runtimeMode !== 'production');

    if (typeof include === 'boolean') return include;

    return include(level);
  }

  private formatTimestamp(): string {
    const now = new Date();
    if (runtimeMode === 'production') return now.toISOString();

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

    const owner = this.config.custom as (BaseLogger & Record<string, unknown>) | undefined;
    const rawSink = owner && typeof owner[level] === 'function' ? (owner[level] as (meta?: Record<string, unknown>, message?: string) => void) : undefined;
    const boundSink = rawSink ? rawSink.bind(owner) : undefined;

    const consoleFallback = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    const hasCustom = !!boundSink;

    // ONE guarded, bounded traversal does stack filtering and denylist redaction together, and it
    // is the FIRST thing that touches caller metadata - no spread or recursive walk precedes it
    // (even Array.isArray on a revoked proxy throws, so the raw value goes straight to the
    // walker). Default denylist only, applied before ANY sink sees metadata - custom sink,
    // console fallback and the singleLine JSON path alike. The message string is untouched (keys
    // are the unit of redaction, not text). A root the walker replaced with a marker survives as
    // { value } instead of vanishing through the hasMeta check.
    const stripStackKeys = !this.shouldIncludeStack(level);
    const safeMeta = meta === undefined ? {} : toSafeRecord(meta, stripStackKeys);
    const ctxSafe = wantCtx && Object.keys(this.context).length > 0 ? redactDeniedKeys(this.context, undefined, { stripStackKeys }) : undefined;
    const withCtx = ctxSafe !== undefined ? { context: ctxSafe, ...safeMeta } : safeMeta;
    const finalMeta = category ? { ...withCtx, category } : withCtx;
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

    const formatted = `${timestamp} ${coloredTag} ${message}`;

    if (this.config.singleLine && hasMeta && !hasCustom) {
      const metaStr = JSON.stringify(finalMeta).replace(/\n/g, '\\n');
      consoleFallback(`${formatted} ${metaStr}`);
      return;
    }

    if (hasCustom) {
      const obj = hasMeta ? (finalMeta as Record<string, unknown>) : {};
      try {
        boundSink!(obj, message);
      } catch {
        hasMeta ? consoleFallback(formatted, finalMeta) : consoleFallback(formatted);
      }
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
