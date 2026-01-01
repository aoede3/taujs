import type { BaseLogger } from './Logger';

const cleanMeta = (meta: unknown): Record<string, unknown> | undefined => {
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) return Object.keys(meta).length ? (meta as Record<string, unknown>) : undefined;

  return undefined;
};
export interface MessageMetaLogger {
  debug?: (message?: string, meta?: Record<string, unknown>) => unknown;
  info?: (message?: string, meta?: Record<string, unknown>) => unknown;
  warn?: (message?: string, meta?: Record<string, unknown>) => unknown;
  error?: (message?: string, meta?: Record<string, unknown>) => unknown;
  child?: (bindings: Record<string, unknown>) => MessageMetaLogger | undefined;
}

export function messageMetaAdapter<L extends MessageMetaLogger>(sink: L): BaseLogger {
  return {
    debug: (meta, message) => sink.debug?.(message, cleanMeta(meta)),
    info: (meta, message) => sink.info?.(message, cleanMeta(meta)),
    warn: (meta, message) => sink.warn?.(message, cleanMeta(meta)),
    error: (meta, message) => sink.error?.(message, cleanMeta(meta)),
    child: (ctx) => messageMetaAdapter(sink.child?.(ctx) ?? sink),
  };
}

export function winstonAdapter(winston: MessageMetaLogger): BaseLogger {
  return messageMetaAdapter(winston);
}
