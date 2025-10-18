import type { BaseLogger } from './Logger';

export function pinoAdapter(pino: any): BaseLogger {
  return {
    debug: (message: string, meta?: unknown) => pino.debug(meta ?? {}, message),
    info: (message: string, meta?: unknown) => pino.info(meta ?? {}, message),
    warn: (message: string, meta?: unknown) => pino.warn(meta ?? {}, message),
    error: (message: string, meta?: unknown) => pino.error(meta ?? {}, message),
  };
}

export function winstonAdapter(winston: any): BaseLogger {
  return {
    debug: (msg: string, meta?: unknown) => winston.debug(msg, meta),
    info: (msg: string, meta?: unknown) => winston.info(msg, meta),
    warn: (msg: string, meta?: unknown) => winston.warn(msg, meta),
    error: (msg: string, meta?: unknown) => winston.error(msg, meta),
  };
}
