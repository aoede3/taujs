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

export function createRequestContext<L extends Logs>(
  req: FastifyRequest,
  reply: FastifyReply,
  baseLogger: L,
  deriveLogger?: (bindings: Record<string, unknown>) => L,
): RequestContext<L> {
  const raw = typeof req.headers['x-trace-id'] === 'string' ? req.headers['x-trace-id'] : '';
  // RFC 0010: τjs adopts the host's request identity rather than inventing a parallel one, so a
  // caller's logs and τjs's records join on the same value. `genReqId` may legitimately return a
  // number - an incrementing counter is a common choice - and a string-only guard silently fell
  // through to a random UUID there, breaking correlation with no warning. Coerce both primitive
  // shapes; anything else is not a usable identity and still gets a fresh UUID.
  const hostRequestId = typeof (req as any).id === 'string' || typeof (req as any).id === 'number' ? String((req as any).id) : '';
  const traceId = raw && REGEX.SAFE_TRACE.test(raw) ? raw : hostRequestId || crypto.randomUUID();

  reply.header('x-trace-id', traceId);

  const bindings = { traceId, reqId: req.id, url: req.url, method: req.method };
  const anyLogger = baseLogger as Logs;
  const child = anyLogger.child;
  const logger = (deriveLogger ? deriveLogger(bindings) : typeof child === 'function' ? child.call(baseLogger, bindings) : baseLogger) as typeof baseLogger;
  const headers: Record<string, string> = Object.fromEntries(
    Object.entries(req.headers as Record<string, string | string[] | undefined>).map(([headerName, headerValue]) => {
      const normalisedValue = Array.isArray(headerValue) ? headerValue.join(',') : (headerValue ?? '');

      return [headerName, normalisedValue];
    }),
  );
  return { traceId, logger, headers };
}
