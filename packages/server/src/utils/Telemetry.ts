import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logs } from '../core/logging/types';
import type { RequestContext } from '../core/telemetry/Telemetry';

// Reads the context hoisted by SSRServer's onRequest hook (P0B-01). undefined when the
// hook is not installed — callers fall back to creating a context in place, which keeps
// direct handler invocation (tests, userland composition) behaving exactly as before.
export function getRequestContext<L extends Logs>(req: FastifyRequest): RequestContext<L> | undefined {
  return (req.taujsRequestContext as RequestContext<L> | null | undefined) ?? undefined;
}

/**
 * Streaming pre-commit failure identity - ENTIRELY INTERNAL to `@taujs/server`. Never exported
 * from the package, never placed on the public loader context or `ServiceContext`. Keyed by the
 * exact request object, so an entry is reachable only for as long as the request itself is and is
 * never readable for any request other than the one that wrote it - a connection, a route or a
 * module-level slot would all leak across requests under keep-alive or load; a `WeakMap` keyed by
 * the request cannot.
 *
 * Written exactly once, only by `HandleRender.ts`'s `failResponse` in its pre-commit branch (the
 * same moment `preCommitFailure.reason` is set there); read exactly once, only by `SSRServer.ts`'s
 * scope error handler, itself gated on the identical structural test `failResponse` already uses
 * (`!reply.raw.headersSent`) - never by inspecting the transport error's shape or message.
 */
const preCommitFailures = new WeakMap<FastifyRequest, { reason: unknown }>();

export function recordPreCommitFailure(req: FastifyRequest, reason: unknown): void {
  preCommitFailures.set(req, { reason });
}

/** Reads and clears the recorded failure for this request, if any. */
export function consumePreCommitFailure(req: FastifyRequest): { reason: unknown } | undefined {
  const failure = preCommitFailures.get(req);
  if (failure) preCommitFailures.delete(req);

  return failure;
}

export function createRequestContext<L extends Logs>(
  req: FastifyRequest,
  reply: FastifyReply,
  baseLogger: L,
  deriveLogger?: (bindings: Record<string, unknown>) => L,
): RequestContext<L> {
  // SC-09: Fastify owns request identity. τjs adopts String(req.id) and never reinterprets an
  // inbound correlation header after Fastify has created the request - header adoption is a
  // construction-time decision (`genReqId`), τjs's own on a created host, the caller's on a
  // supplied one. Fastify guarantees a request ID, and `genReqId` may legitimately return a
  // number - an incrementing counter is a common choice - so both primitive shapes are usable
  // identity. Anything else is a host violating that contract: fail explicitly rather than
  // silently inventing a parallel identity that could never match the host's own records.
  const hostId = (req as { id?: unknown }).id;
  if (typeof hostId !== 'string' && typeof hostId !== 'number') {
    throw new TypeError(`SC-09: Fastify guarantees a string or number req.id; received ${hostId === null ? 'null' : typeof hostId}`);
  }
  const requestId = String(hostId);

  reply.header('x-request-id', requestId);

  // `reqId` stays in Fastify's native type so a caller's numeric ID appears numeric, matching the
  // host's own request logs; its textual identity always agrees with `requestId`.
  const bindings = { reqId: req.id, url: req.url, method: req.method };
  const anyLogger = baseLogger as Logs;
  const child = anyLogger.child;
  const logger = (deriveLogger ? deriveLogger(bindings) : typeof child === 'function' ? child.call(baseLogger, bindings) : baseLogger) as typeof baseLogger;
  const headers: Record<string, string> = Object.fromEntries(
    Object.entries(req.headers as Record<string, string | string[] | undefined>).map(([headerName, headerValue]) => {
      const normalisedValue = Array.isArray(headerValue) ? headerValue.join(',') : (headerValue ?? '');

      return [headerName, normalisedValue];
    }),
  );
  return { requestId, logger, headers, url: req.url };
}
