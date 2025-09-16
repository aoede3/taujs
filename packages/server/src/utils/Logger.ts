import type { FastifyRequest } from 'fastify';
import pc from 'picocolors';

export type Logger = {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export function createLogger(debug: boolean, custom?: Partial<Logger>): Logger {
  return {
    log: (...args: unknown[]) => {
      if (debug) (custom?.log ?? console.log)(...args);
    },

    warn: (...args: unknown[]) => {
      (custom?.warn ?? console.warn)(...args);
    },

    error: (...args: unknown[]) => {
      (custom?.error ?? console.error)(...args);
    },
  };
}

export const debugLog = (logger: Logger, message: string, req?: FastifyRequest) => {
  const prefix = pc.cyan('[τjs]');
  const method = req?.method ?? '';
  const url = req?.url ?? '';
  const ts = pc.gray(new Date().toLocaleTimeString());
  const parts = [ts, prefix];

  if (method && url) parts.push(`${method} ${url}`);
  parts.push(message);

  logger.log(parts.join(' '));
};
