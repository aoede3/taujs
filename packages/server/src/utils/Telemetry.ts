import crypto from 'node:crypto';

import { REGEX } from '../core/constants';

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logs } from '../core/logging/types';
import type { RequestContext } from '../core/telemetry/Telemetry';

// Reads the context hoisted by SSRServer's onRequest hook (P0B-01). undefined when the
// hook is not installed — callers fall back to creating a context in place, which keeps
// direct handler invocation (tests, userland composition) behaving exactly as before.
export function getRequestContext<L extends Logs>(req: FastifyRequest): RequestContext<L> | undefined {
  return (req.taujsRequestContext as RequestContext<L> | null | undefined) ?? undefined;
}

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
