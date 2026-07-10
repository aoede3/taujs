# @taujs/react

## 0.2.1

### Patch Changes

- [#10](https://github.com/aoede3/taujs/pull/10) [`c8712a6`](https://github.com/aoede3/taujs/commit/c8712a655909512d044bc4baccbedc1312fe4237) Thanks [@aoede3](https://github.com/aoede3)! - Mark the `onFinish` render callback as `@deprecated` in its JSDoc (it is a legacy alias of
  `onAllReady`); use `onAllReady` instead. Documentation-only; no behaviour change.

## 0.2.0

### Minor Changes

- [#6](https://github.com/aoede3/taujs/pull/6) [`bc98103`](https://github.com/aoede3/taujs/commit/bc981030836f811028518b0d2c471e3d04c1c5b9) Thanks [@aoede3](https://github.com/aoede3)! - P0B-04: `hydrateApp` emits internal dev-only lifecycle events (`hydration:start` / `hydration:success` / `hydration:error`) through `window.__TAUJS_DEVTOOLS_HOOK__` when the server-injected dev script has set it. User callbacks are unchanged and always run (internal emission first, user callback second); a missing or throwing hook can never affect hydration. CSR-fallback mounts deliberately emit nothing — mounting fresh is not a hydration, and the trace's `client` field stays an honest null.

v0.1.9 - 20/05/2026

feat: Fix `createSSRStore()` exposing stale `status` and `lastError` values.

v0.1.8 - 14/01/2026

feat: @vitejs/plugin-react shim for preamble streaming
chore: update packages

v0.1.7 - 11/01/2026

feat: remove resolve route data

v0.1.6 - 29/12/2025

feat: rename \_\_taujs/data to \_\_taujs/route as explicit route data contract

v0.1.5 - 01/12/2025

feat: align streaming ownership boundary to template

v0.1.4 - 01/12/2025

feat: routeContext

v0.1.3 - 23/11/2025

feat: hydration csr data provider wrapped when empty data; tests

v0.1.2 - 23/11/2025

feat: RouteData, tests; coverage
feat: logger alignment with taujs/server; tests
feat: isolating HeadContext; providing export

v0.1.1 - 25/10/2025

feat: Optimise hot paths

v0.1.0 - 20/10/2025

feat: optimisation
feat: Streaming backpressure; semantics; coverage
feat: Logger; streaming updates; coverage
feat: useDeferredValue in store; render head data snapshots
feat: debug logger; associated tests
chore: update vite; vitest

v0.0.8 - 15/08/2025

feat: cspNonce addition + tests

v0.0.7 - 10/07/2025

chore(deps): pin taujs/server to 0.3.0

v0.0.6 - 05/07/2025

feat: SSRDataStore error handling
test: SSRDataStore error handling
test: plugin coverage

v0.0.5 - 30/06/2025

feat: Integrate build plugin helper; tsup config

v0.0.4 - 18/06/2025

feat: SSRRender head resolution timing

v0.0.3 - 18/06/2025

feat: SSRRender head resolution timing; align SSRender + SSRServer
chore(deps): bump brace-expansion from 2.0.1 to 2.0.2

v0.0.2 - 10/06/2025

feat: Update README

v0.0.1 - 10/06/2025

Initial taujs-react
