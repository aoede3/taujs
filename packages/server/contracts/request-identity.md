# Request identity and episode correlation

Contract id: `server:request-identity`. Owner: `@taujs/server` (this document's version is the
installed package's version).

## Formerly cited as SC-09

This contract replaces the retired `SC-09` identifier used when canonical request identity shipped
in PR #55 with `@taujs/server` 0.18.0. Historical changelog references retain that name; current
source cites the precise ruling it relies on here.

### Ruling 1: Fastify request ID is canonical

Fastify's `req.id` is the canonical request-correlation identity in both τjs-created and
caller-owned hosts. The request context stores `requestId: String(req.id)`. The episode recorder
uses that same string as its key, and τjs-owned responses send it in `x-request-id`.

Fastify 5.10.0's public request and `genReqId` types promise a string. At runtime, a custom
`genReqId` can return a number despite that public type; τjs defensively accepts such a value and
uses `String(req.id)` for textual correlation while preserving the number in native `reqId` log
bindings. This defensive acceptance does not claim that Fastify supports numeric request IDs.
Values other than strings or numbers fail explicitly when τjs creates the request context; τjs
does not invent a second identity.

Evidence: [context construction](../src/utils/Telemetry.ts#L45),
[host matrix cell](../src/test/CanonicalRequestIdentity.test.ts#L88), and
[numeric type-escape cell](../src/test/CanonicalRequestIdentity.test.ts#L232).

### Ruling 2: The episode key is the textual request ID

The episode key is `String(req.id)`, the same value stored as request-context `requestId`. There is
no second identity selection and no separate `episodeId`.

Evidence: [request context](../src/utils/Telemetry.ts#L52),
[caller-owned-host recorder cell](../src/test/HostOwnershipDevelopment.test.ts#L185), and
[created-host recorder cell](../src/test/HostOwnershipDevelopment.test.ts#L203).

### Ruling 3: Inbound headers are not reinterpreted after construction

τjs adopts `String(req.id)` in every host mode. It does not inspect an inbound correlation header
to replace an identity after Fastify has created the request.

Evidence: [identity selection](../src/utils/Telemetry.ts#L45),
[request-context cell](../src/test/SSRServerRequestContext.test.ts#L76), and
[header-negative cells](../src/test/CanonicalRequestIdentity.test.ts#L143).

### Ruling 4: Created hosts validate header adoption

For a τjs-created host, τjs supplies `genReqId` when creating Fastify. It adopts one string-valued
`x-request-id` only if it matches the safe-request-ID expression. Missing, malformed, or repeated
headers (which arrive as an array) receive a generated UUID. `requestIdHeader` remains unset:
Fastify uses that option to adopt a header before calling `genReqId`, without validation.

Evidence: [host construction](../src/CreateServer.ts#L129),
[created-host matrix cell](../src/test/CanonicalRequestIdentity.test.ts#L88), and the
[Fastify 5.10.0 lock](../../../pnpm-lock.yaml#L2193).

### Ruling 5: Caller-owned hosts control header adoption

For a caller-owned host, the caller's Fastify construction policy controls `req.id`; τjs neither
changes that policy nor reinterprets the inbound header. A caller that wants to adopt
`x-request-id` should use a validating `genReqId` with the same single-string rule, not
`requestIdHeader`.

Evidence: [caller recipe](../src/test/support/hostOwnership.ts#L228) and
[caller-owned-host matrix cell](../src/test/CanonicalRequestIdentity.test.ts#L158).

### Ruling 6: Owned responses echo request IDs

Only responses to τjs-owned routes echo `String(req.id)` as `x-request-id`. Caller-owned routes
remain under the caller's response policy and do not gain τjs request episodes.

Evidence: [owned response header](../src/utils/Telemetry.ts#L58), the
[matrix response reader](../src/test/support/hostOwnership.ts#L69), and a
[complete identity row](../src/test/CanonicalRequestIdentity.test.ts#L107).

### Ruling 7: Request identity is not distributed tracing

`requestId` and `x-request-id` identify and correlate one HTTP request and its τjs episode. They are
not W3C trace IDs, OpenTelemetry trace IDs, or span IDs. Distributed tracing remains a separate
future concern carried through standard trace context such as `traceparent`.

Evidence: [request-context vocabulary](../src/core/telemetry/Telemetry.ts#L4) and the
[identity matrix](../src/test/CanonicalRequestIdentity.test.ts#L88).

### Ruling 8: Public identity names use request vocabulary

Public request-context and structured-record identity is named `requestId`. The HTTP header is
`x-request-id`, and the Fastify-native log binding is `reqId`; there is no `traceId` compatibility
alias. A future OpenTelemetry `traceId` remains distinct.

The request logger's `reqId` retains Fastify's native value and type. Its textual value agrees with
`requestId`. A child logger inherits `reqId` through logger lineage; service and deferred-data code
must not bind it again. If a logger has no request lineage, it carries no request identity.

Evidence: [request logging](../src/utils/Telemetry.ts#L58),
[service lineage](../src/core/services/DataServices.ts#L275),
[deferred lineage](../src/core/routes/DeferredData.ts#L210), and the
[service logger cell](../src/core/services/test/DataServices.test.ts#L174).

### Ruling 9: Request observations use episode vocabulary

The development recorder describes request observations as episodes. Public names use
`EpisodeRecorder`, `EpisodeRecord`, `getEpisodes`, `findEpisode`, `episodes.ndjson`,
`/__taujs/episodes`, and the `taujs_get_*_episode*` tools. The episode key is `requestId`; there is
no separate `episodeId`.

Legacy trace-named request-observation surfaces are removed. At boot, τjs removes a stale
`traces.ndjson`; current `dev.json` advertises only `episodes.ndjson`, and MCP does not treat the
legacy file as current-boot evidence. The legacy `/__taujs/traces` endpoint and old MCP trace tools
are absent. Historical changelogs and tests that prove legacy rejection may retain the old names.

Evidence: [stale-file removal](../src/core/introspection/DevFiles.ts#L83),
[endpoint cells](../src/core/introspection/test/DevEndpointsFiles.test.ts#L271), and the
[MCP legacy-file cell](../../mcp/src/test/SubstrateReader.test.ts#L227).

## Identity invariant

```text
String(req.id) = request-context requestId = episode key = owned-response x-request-id
```
