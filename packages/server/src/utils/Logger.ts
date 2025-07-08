import type { FastifyRequest } from 'fastify';

type Logger = {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export const createLogger = (debug: boolean): Logger => ({
  log: (...args: unknown[]) => {
    if (debug) console.log(...args);
  },
  warn: (...args: unknown[]) => {
    if (debug) console.warn(...args);
  },
  error: (...args: unknown[]) => {
    if (debug) console.error(...args);
  },
});

export const debugLog = (logger: Logger, message: string, req?: FastifyRequest) => {
  const prefix = '[τjs]';
  const method = req?.method ?? '';
  const url = req?.url ?? '';
  const tag = method && url ? `${method} ${url}` : '';

  logger.log(`${prefix} ${tag} ${message}`);
};
