import type { CustomLogger } from './Logger';

export function pinoAdapter(pino: any, baseCtx?: Record<string, unknown>): CustomLogger {
  const logger = pino.child(baseCtx ?? {});
  const isObjectFirst = (msgOrObj: unknown, meta: unknown) =>
    meta === undefined && msgOrObj != null && typeof msgOrObj === 'object' && !Array.isArray(msgOrObj);

  return {
    debug: (msgOrObj: any, meta?: unknown) => (isObjectFirst(msgOrObj, meta) ? logger.debug(msgOrObj) : logger.debug(meta ?? {}, msgOrObj as string)),
    info: (msgOrObj: any, meta?: unknown) => (isObjectFirst(msgOrObj, meta) ? logger.info(msgOrObj) : logger.info(meta ?? {}, msgOrObj as string)),
    warn: (msgOrObj: any, meta?: unknown) => (isObjectFirst(msgOrObj, meta) ? logger.warn(msgOrObj) : logger.warn(meta ?? {}, msgOrObj as string)),
    error: (msgOrObj: any, meta?: unknown) => (isObjectFirst(msgOrObj, meta) ? logger.error(msgOrObj) : logger.error(meta ?? {}, msgOrObj as string)),
  };
}
