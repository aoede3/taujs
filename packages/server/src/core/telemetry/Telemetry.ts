import crypto from 'node:crypto';

import { REGEX } from '../constants';

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logs } from '../logging/types';

export type RequestContext<L extends Logs = Logs> = {
  traceId: string;
  logger: L;
  headers: Record<string, string>;
};

export function createRequestContext<L extends Logs>(req: FastifyRequest, reply: FastifyReply, baseLogger: L): RequestContext<L> {
  const raw = typeof req.headers['x-trace-id'] === 'string' ? req.headers['x-trace-id'] : '';
  const traceId = raw && REGEX.SAFE_TRACE.test(raw) ? raw : typeof (req as any).id === 'string' ? (req as any).id : crypto.randomUUID();

  reply.header('x-trace-id', traceId);

  const anyLogger = baseLogger as Logs;
  const child = anyLogger.child;
  const logger = (typeof child === 'function' ? child.call(baseLogger, { traceId, url: req.url, method: req.method }) : baseLogger) as typeof baseLogger;
  const headers: Record<string, string> = Object.fromEntries(
    Object.entries(req.headers as Record<string, string | string[] | undefined>).map(([headerName, headerValue]) => {
      const normalisedValue = Array.isArray(headerValue) ? headerValue.join(',') : (headerValue ?? '');

      return [headerName, normalisedValue];
    }),
  );
  return { traceId, logger, headers };
}
