# @taujs/mcp

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
