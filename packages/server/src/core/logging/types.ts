export const DEBUG_CATEGORIES = ['auth', 'routes', 'errors', 'vite', 'network', 'ssr'] as const;
export type DebugCategory = (typeof DEBUG_CATEGORIES)[number];

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type DebugConfig = boolean | DebugCategory[] | ({ all?: boolean } & Partial<Record<DebugCategory, boolean>>);

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
  isDebugEnabled?(category: DebugCategory): boolean;
}
