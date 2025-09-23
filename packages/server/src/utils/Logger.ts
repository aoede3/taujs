import pc from 'picocolors';

import { normaliseServiceError, logServiceError } from './ServiceError';
import { DEBUG } from '../constants';

export type Logger = {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  serviceError: (err: unknown, context?: Record<string, unknown>) => never;
};

export type DebugCategory = keyof typeof DEBUG;
export type DebugColour = (typeof DEBUG)[keyof typeof DEBUG]['colour'];

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
  const allOff = Object.fromEntries(Object.keys(DEBUG).map((k) => [k, false])) as Record<DebugCategory, false>;
  const allOn = Object.fromEntries(Object.keys(DEBUG).map((k) => [k, true])) as Record<DebugCategory, true>;

  if (config === undefined) return { ...allOff, errors: true };

  if (typeof config === 'boolean') {
    return Object.fromEntries(Object.keys(allOn).map((k) => [k, config])) as Record<DebugCategory, boolean>;
  }

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
  const color = DEBUG[category].colour;
  const tag = color(`[${category}]`);

  const parts = [ts, tag, message];

  if (req?.method && req?.url) {
    parts.push(`${req.method} ${req.url}`);
  } else if (req?.url) {
    parts.push(req.url);
  }

  logger.log(parts.join(' '));
};
