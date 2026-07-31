---
'@taujs/server': minor
'@taujs/mcp': minor
---

Fastify `req.id` is now the canonical request-correlation identity in both host modes (SC-09).

Behaviour changes:

- τjs no longer reinterprets an inbound correlation header after Fastify has created the request.
  The request identity is always `String(req.id)`; header adoption is a construction-time decision.
- On a τjs-created host, τjs now configures `genReqId` at Fastify construction: a single valid
  inbound `x-request-id` becomes `req.id`, otherwise a UUID is generated. Previously the created
  host used Fastify's default counter (`req-1`), so created-host identities visibly change shape.
- On a caller-owned host, τjs adopts whatever `req.id` the host produced. Hosts that previously
  sent `x-trace-id` and relied on τjs echoing it must now adopt inbound correlation themselves at
  Fastify construction with a validating `genReqId` (not `requestIdHeader`, which takes the header
  unvalidated).
- Request log bindings collapse to the Fastify-native `reqId` alone, in its native type; the
  duplicate identity binding is dropped. Service-dispatch child loggers bind `requestId`.

Renames, with no compatibility aliases:

- request-context and structured-record field `traceId` becomes `requestId`
- header `x-trace-id` becomes `x-request-id`, inbound and outbound; inbound `x-trace-id` is no
  longer recognised
- `REGEX.SAFE_TRACE` becomes `REGEX.SAFE_REQUEST_ID`
- browser stamp `__TAUJS_TRACE_ID__` becomes `__TAUJS_REQUEST_ID__`; the hydration beacon field
  `traceId` becomes `requestId`, and its rejection reason `invalid_trace_id` becomes
  `invalid_request_id`
- MCP tool argument and returned field `traceId` become `requestId`; `sampleTraceIds` becomes
  `sampleRequestIds`

`requestId` is application request correlation, not a W3C or OpenTelemetry trace ID. A future
distributed-tracing integration uses `traceparent` and its own trace and span identities.
