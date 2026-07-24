# @taujs/mcp

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
