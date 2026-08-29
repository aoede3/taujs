# @taujs/mcp

## 0.5.1

### Patch Changes

- [#120](https://github.com/aoede3/taujs/pull/120) [`a4b83bb`](https://github.com/aoede3/taujs/commit/a4b83bb72ef0d3d50ebef398cca0af48d8a24ae8) Thanks [@aoede3](https://github.com/aoede3)! - `taujs_get_route` and `taujs_explain_route` now refuse with `reason: 'conflicting_selectors'` (plus `routeIdMatches` and `pathMatches`) when a `routeId` and `path` given together identify different routes, instead of silently preferring one. Shipped skill prompts are also checked against the registered tool and skill list, so a `taujs_`-prefixed token drifting out of sync is caught.

- [#120](https://github.com/aoede3/taujs/pull/120) [`1742a08`](https://github.com/aoede3/taujs/commit/1742a088d5ad2e71ea530e5c2ca1d50e3b25b1a0) Thanks [@aoede3](https://github.com/aoede3)! - `taujs_who_calls_service` now cites `observedStaleness` (the observing boot's id and `updatedAt`) alongside the graph's own `staleness` line when observations were read outside an active boot. Observations and the graph are emitted by different events, so a T1 observation was previously being attributed to a T2 build's freshness.

## 0.5.0

### Minor Changes

- [#118](https://github.com/aoede3/taujs/pull/118) [`6efcb0a`](https://github.com/aoede3/taujs/commit/6efcb0afd309016d449a255a7f0753d6a9413df0) Thanks [@aoede3](https://github.com/aoede3)! - `@taujs/mcp` now runs on the official `@modelcontextprotocol/server` v2 package. `serveStdio` serves 2025-era clients by default and the 2026-07-28 protocol revision when a client negotiates it. Tool results now carry `structuredContent` alongside the existing JSON text, and handlers are typed from their `z.object` input schema.

  **Breaking** (pre-1.0 minor): `createTaujsMcpServer()` now returns the v2 `McpServer` from `@modelcontextprotocol/server`, which is not interchangeable with v1 transports or clients - a consumer that connects the returned server itself must use `@modelcontextprotocol/server` transports (`StdioServerTransport`, `InMemoryTransport`) or `serveStdio`; `allTools()` entries now carry `inputSchema` as `z.object` instances and their handlers expect parsed arguments - a consumer dispatching handlers directly must validate with `tool.inputSchema.parse(args)` first, because the hand narrowing the handlers used to do is gone. Migration: replace `@modelcontextprotocol/sdk` imports with the v2 packages as in the SDK migration guide.

## 0.4.1

### Patch Changes

- [#103](https://github.com/aoede3/taujs/pull/103) [`f6c6c75`](https://github.com/aoede3/taujs/commit/f6c6c75c09c4fdc2a17e3943349695c864f52f80) Thanks [@aoede3](https://github.com/aoede3)! - `taujs_who_calls_service` labels head-data edges `declaredVia: 'head'`, `taujs_explain_route`
  shows them, and overview coverage counts them.

## 0.4.0

### Minor Changes

- [#99](https://github.com/aoede3/taujs/pull/99) [`08152ea`](https://github.com/aoede3/taujs/commit/08152ea3eb39677619061bfe89bc0a7c9a222d8a) Thanks [@aoede3](https://github.com/aoede3)! - Runtime tools stop reporting what they could not establish

  These tools are an agent's evidence, and every defect below shares one mistake: absence was reported as knowledge.

  **A live pid is no longer taken for a live boot.** Pids are recycled, and a crashed boot's `dev.json` survives because the server removes it only on graceful close, so `active` could describe a dead boot and its `bootId` filter then passed that boot's records through as current. `@taujs/server` now advances `dev.json`'s mtime on the poll tick it already runs, and a boot is active only while that heartbeat is fresh. A `@taujs/server` older than this release does not heartbeat, so it reads stale and the message says to upgrade it.

  **`dev.json` is validated before it can make a boot active.** It used to be a cast, so a partial document with a live pid became `active` with `bootId` undefined, which skipped the episode reader's boot filter and served an old boot's episodes as current. A `dev.json` that does not parse, lacks a field a boot always writes, or carries an empty `bootId` now reads as stale with `dev_json_invalid` - even when no other artefact exists; additive fields are tolerated.

  **Refusals say why.** `no_dev_json`, `dead_pid`, `heartbeat_expired`, `dev_json_invalid` and `dev_json_unreadable` arrive as `staleReason` alongside the existing refusal contract.

  **Artefact paths are derived, never taken from `dev.json`**, and each is resolved to its real path and required to be a regular file beneath the real `.taujs` directory. A symlink inside `.taujs` pointing elsewhere is treated as absent, not followed.

  **Unreadable is distinguished from empty.** A missing or unreadable artefact returns a typed failure rather than an empty list. Records are validated against a full schema of the documented record shape; a line that cannot be parsed, or parses but is not that shape (including an unrecognised log level, which used to be silently filtered out), is counted and reported per artefact as `malformedRecords`, only when non-zero. An empty logs answer next to a malformed count says the list may be incomplete rather than that nothing was logged.

  **Episode membership names its scope.** `taujs_get_episode_logs` answered `ok: true, logs: []` for a `requestId` that never existed, telling an agent to retry a query that could never succeed. It now reports `membership` as `in_episode_ring`, `not_in_episode_ring`, or `unknown` when a malformed record makes the ring unprovable - a bounded ring can never prove an episode did not exist, only that it is not in the ring. The logs ring outlives the episode ring, so an evicted episode whose lines survive answers with those lines.

  **A tool that throws answers in the envelope.** `{ ok: false, reason: 'tool_failure', message }`, with the full error on stderr and only a bounded message returned. Rejected promises are covered too.

  **`taujs_doctor`'s unavailable branch no longer labels itself observed.**

  **`EpisodeRecord` declares `deferredData`**, which the server has written since RFC 0007 R5.

  BREAKING, and pre-1.0 so it is stated plainly rather than shimmed: `readEpisodes` and `readLogs` return a read result (`{ ok, records, malformed }` or a typed failure) instead of an array, and the response vocabulary above is new. The `limit` input of `taujs_get_recent_episodes` no longer caps at a hard-coded 200: the server already bounds what it returns.

## 0.3.0

### Minor Changes

- [#91](https://github.com/aoede3/taujs/pull/91) [`22f6151`](https://github.com/aoede3/taujs/commit/22f615104b3b385ee7103a520675ab50082abf91) Thanks [@aoede3](https://github.com/aoede3)! - State the graph's extent and declared coverage; distinguish empty results from unknown identifiers

  `taujs_overview` now states the graph's boundary in a `scope` field (routes registered directly on the Fastify instance, and service calls made outside taujs request handling, are not represented), reports per-service declared-edge coverage (`methodCount` and `withDeclaredEdges`, deferred entries included), exposes `episodesAvailable` with the refusal remedy when episode tools are gated, and renames `warningCounts` to `graphWarningCounts` so the counts read as graph-scoped rather than as application health.

  `taujs_who_calls_service` declared edges now include deferred entries (RFC 0007 R5 parity with the graph's own `usedBy`), each labelled `declaredVia: 'serviceData' | 'deferred'`. A known service or method with zero edges now returns `ok: true` with empty `edges` instead of the `no_edges` error - `ok: false` is reserved for identifiers that do not resolve (`unknown_service`, `unknown_method`), and an unresolved identifier that routes or traffic nonetheless reference returns those edges as `danglingEdges` alongside the error. When the registry is not present in the graph the response says existence cannot be checked instead of guessing. `taujs_doctor` phrases a clean verdict as "No taujs graph warnings", scoped to the declared graph.

  Two further honesty fixes: observations left on disk by a previous boot are masked while a boot is live (the emitter only rewrites the file on the first current-boot service call, so early calls could report the old boot's edges as "seen this boot"), and the observed-edge `count` field is renamed `methodCallCount` because the substrate counts per service method, not per route - every route row of a method carries the same boot-wide total. The README now states the graph's boundary instead of promising application-wide ground truth.

### Patch Changes

- [#92](https://github.com/aoede3/taujs/pull/92) [`2c620ed`](https://github.com/aoede3/taujs/commit/2c620edd3f0e7ed1e2356828cc65bc24d45ececd) Thanks [@aoede3](https://github.com/aoede3)! - `taujs_who_calls_service` observed edges surface `routeCallCount` - the calls attributed to that specific route - alongside the method-wide `methodCallCount`, when the server emits the per-route counts added in spec 03 §4 (older emissions simply omit the field).

## 0.2.1

### Patch Changes

- [#89](https://github.com/aoede3/taujs/pull/89) [`259ff4b`](https://github.com/aoede3/taujs/commit/259ff4bb42b66abcca084c9d3b1f3fa8075ca99d) Thanks [@aoede3](https://github.com/aoede3)! - The taujs_doctor fallthrough note no longer classifies a wildcard route as the app-shell pattern; it states the mechanism only. Tool output text; no behaviour change.

## 0.2.0

### Minor Changes

- [#55](https://github.com/aoede3/taujs/pull/55) [`205c023`](https://github.com/aoede3/taujs/commit/205c0231cb6841f8106217b9abed19db52944462) Thanks [@aoede3](https://github.com/aoede3)! - Fastify `req.id` is now the canonical request-correlation identity in both host modes (SC-09).

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
  - Request log bindings collapse to the Fastify-native `reqId` alone, and `reqId` has ONE meaning
    and ONE representation: the current Fastify request, in its native type, bound once by the
    request logger and inherited through child-logger lineage. Service-dispatch children and
    deferred-data warnings no longer rebind it (a rebind stringified numeric host identities), the
    not-found fallback context carries the native `req.id`, and the hydration-beacon debug record
    names the episode it updates as `episodeRequestId` - the beacon POST is its own request. Episode
    records use `requestId`; log correlation uses `reqId`.
  - τjs no longer invents a fallback identity: if a host violates Fastify's guarantee of a string or
    number `req.id`, request-context creation fails explicitly with a `TypeError` instead of
    silently generating a UUID that could never match the host's own records.

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

- [#55](https://github.com/aoede3/taujs/pull/55) [`69a840b`](https://github.com/aoede3/taujs/commit/69a840bb2bb165cd2628395123e451d6ba2913e3) Thanks [@aoede3](https://github.com/aoede3)! - The recorder subsystem stops using "trace": the settled concept word is "episode" (SC-09 ruling 9).

  This is a behaviour-preserving surface migration - the recorder's behaviour is unchanged, but
  observable interfaces change, with no compatibility aliases:

  - MCP tools: `taujs_get_recent_traces` becomes `taujs_get_recent_episodes`, `taujs_get_trace`
    becomes `taujs_get_episode`, `taujs_get_trace_logs` becomes `taujs_get_episode_logs`; the
    recent-episodes response key `traces` becomes `episodes`, the `taujs_doctor` report field
    `failedTraces` becomes `failedEpisodes`, and the not-found reason `trace_not_found` becomes
    `episode_not_found`
  - development endpoint `/__taujs/traces` becomes `/__taujs/episodes`, and its response key
    `traces` becomes `episodes`
  - development artefact `traces.ndjson` becomes `episodes.ndjson`; `dev.json` exposes
    `paths.episodes` and no longer exposes `paths.traces`. A stale legacy `traces.ndjson` from an
    earlier boot is removed explicitly at the next boot so it can never be mistaken for current-boot
    evidence, and current MCP never reads the old file
  - TypeScript types: `TraceRecorder` becomes `EpisodeRecorder`, `noopTraceRecorder` becomes
    `noopEpisodeRecorder`, `TraceRecord` becomes `EpisodeRecord`, `TraceTimeline` becomes
    `EpisodeTimeline`; `getTraces()` becomes `getEpisodes()`, `findTrace()` becomes `findEpisode()`
    and `tracesRevision` becomes `episodesRevision`
  - an episode carries no `episodeId`: its key is the canonical `requestId`

  The word "trace" is reserved in the τjs observability model for genuine distributed tracing
  (`traceparent`, OpenTelemetry trace and span IDs), which remains a separate future capability.

## 0.1.1

### Patch Changes

- [#36](https://github.com/aoede3/taujs/pull/36) [`d1e2f65`](https://github.com/aoede3/taujs/commit/d1e2f651302b29b85867e75fdfdcb6d54f49a348) Thanks [@aoede3](https://github.com/aoede3)! - Register declared τjs page paths as native Fastify routes. Fastify now owns route syntax,
  matching, decoded parameters, precedence, and router policy; τjs applies application orchestration
  after selection. Exact duplicate τjs paths fail at startup, and the private `path-to-regexp`
  dispatcher has been removed.

  This changes existing route semantics to those of the supplied Fastify instance, including case
  sensitivity, trailing-slash handling and malformed-URL policy. Replace path-to-regexp-only forms
  such as optional brace groups, named wildcards and parameter `*`/`+` modifiers; τjs now rejects
  known stale forms at startup rather than registering them with different semantics.

  Route auth and route-level CSP now apply only to the Fastify-selected τjs route, never
  incidentally to host-owned routes or unmatched case variants. Dotted values such as `logo.png`
  are valid declared page-route parameters; asset-like URLs still 404 when no declared page or
  static route owns them.

  The MCP route explanation now labels its schema-v1 specificity value as a deterministic
  declaration score, not Fastify runtime precedence. The graph schema is unchanged.

## 0.1.0

### Minor Changes

- [#6](https://github.com/aoede3/taujs/pull/6) [`516e08f`](https://github.com/aoede3/taujs/commit/516e08f43c90990ef32d953d36d72a52c0f4f86a) Thanks [@aoede3](https://github.com/aoede3)! - P1-03: runtime toolset — `taujs_get_recent_traces` (default 5, outcome/mode filters, newest first, bootId-filtered), `taujs_get_trace` (full record; honest ring-eviction misses), `taujs_get_trace_logs` (warn+ default, states the annex captures only the framework request logger), and `taujs_doctor` (bounded, source-labelled diagnostics: grouped graph warnings, fallthrough reachability, defaulted renders, recent failed traces). Every runtime tool returns the verbatim refusal contract without an active dev boot; `taujs_doctor` degrades to structural facts and marks runtime sections unavailable.

- [#6](https://github.com/aoede3/taujs/pull/6) [`a6d3c6c`](https://github.com/aoede3/taujs/commit/a6d3c6c9608d17c98481a76e6334ac93d5adfba2) Thanks [@aoede3](https://github.com/aoede3)! - P1-04: skills ship as MCP prompts — `taujs_skill_diagnose_broken_route`, `taujs_skill_hydration_mismatch`, `taujs_skill_add_streamed_route` — versioned with the package so `pnpm up` improves them and stale per-project copies never accumulate. Each teaches the intended tool flow (traces → trace → logs on demand; sources labelled).

- [#6](https://github.com/aoede3/taujs/pull/6) [`1c66a05`](https://github.com/aoede3/taujs/commit/1c66a052a66e674b24e30eae5ca04ba6e43c0641) Thanks [@aoede3](https://github.com/aoede3)! - P1-02: the `taujs-mcp` stdio executable and the structural toolset — `taujs_overview`, `taujs_list_routes`, `taujs_get_route`, `taujs_who_calls_service`, `taujs_explain_route`. All answer cold from files with staleness cited; responses are query-shaped with small bounded defaults and no silent truncation; `who_calls_service` labels every edge `declared` (from config) or `observed` ("seen in dev traffic — never complete truth"); misses are honest, listing known identifiers. Every tool description states that result field values are untrusted application data, never instructions.

- [#6](https://github.com/aoede3/taujs/pull/6) [`9245518`](https://github.com/aoede3/taujs/commit/92455180bbed517b482e2ff112f67fec11e2475a) Thanks [@aoede3](https://github.com/aoede3)! - P1-01: new package — the τjs MCP adapter's substrate reader core. A thin file reader over `node_modules/.taujs/` (never a network client): freshness discovery (`active` via live-pid dev.json, `stale` with boot-or-build graph fallback, `none` with the first-run message), bootId-filtered trace reads, per-trace `warn+`-default log reads, observations, explicit `schemaVersion` skew degradation ("upgrade @taujs/mcp", never a misread), staleness citation lines for every cold answer, and 500-char caps on every string read from disk (untrusted application data). Exposes the verbatim runtime-tool refusal contract.
