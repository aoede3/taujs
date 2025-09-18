import pc from 'picocolors';

import { normaliseServiceError, logServiceError } from './ServiceError';

export type Logger = {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  serviceError: (err: unknown, context?: Record<string, unknown>) => never;
};

export type DebugCategory = 'auth' | 'errors' | 'routes' | 'trx' | 'vite';

export type DebugConfig = boolean | Partial<Record<DebugCategory, boolean>> | ({ all: boolean } & Partial<Record<DebugCategory, boolean>>);

export const createLogger = (debug: DebugConfig = false, custom?: Partial<Logger>): Logger => {
  const config = normaliseDebug(debug);

  const base = {
    log: (...args: unknown[]) => {
      if (Object.values(config).some(Boolean)) (custom?.log ?? console.log)(...args);
    },
    warn: (...args: unknown[]) => (custom?.warn ?? console.warn)(...args),
    error: (...args: unknown[]) => (custom?.error ?? console.error)(...args),
  };

  const serviceError = (err: unknown, context: Record<string, unknown> = {}): never => {
    const se = normaliseServiceError(err, 'infra');
    logServiceError(base, se);
    base.error(pc.red('Service failure'), { ...context, error: se });

    throw se;
  };

  return { ...base, serviceError };
};

export const normaliseDebug = (config: DebugConfig | undefined): Record<DebugCategory, boolean> => {
  const allOn: Record<DebugCategory, true> = {
    routes: true,
    trx: true,
    vite: true,
    auth: true,
    errors: true,
  };

  if (config === undefined) return { ...allOn, errors: true };

  if (typeof config === 'boolean') return Object.fromEntries(Object.keys(allOn).map((k) => [k, config])) as Record<DebugCategory, boolean>;

  if ('all' in config) {
    const base = Object.fromEntries(Object.keys(allOn).map((k) => [k, config.all])) as Record<DebugCategory, boolean>;
    return { ...base, ...config };
  }

  return { ...allOn, ...config };
};

export const debugLog = (logger: Logger, category: DebugCategory, message: string, debug?: DebugConfig, req?: { method?: string; url?: string }) => {
  if (debug === undefined) return;

  const cfg = normaliseDebug(debug);

  if (!cfg[category]) return;

  const ts = pc.gray(new Date().toLocaleTimeString());
  const parts = [ts, pc.yellow(`[${category}]`), message];

  if (req?.method && req?.url) {
    parts.push(`${req.method} ${req.url}`);
  } else if (req?.url) {
    parts.push(req.url);
  }

  logger.log(parts.join(' '));
};
