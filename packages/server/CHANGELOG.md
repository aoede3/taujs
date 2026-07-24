# @taujs/server

## 0.14.0

### Minor Changes

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

## 0.13.0

### Minor Changes

- [#28](https://github.com/aoede3/taujs/pull/28) [`c61c3c1`](https://github.com/aoede3/taujs/commit/c61c3c1a54f44b977725f858e2b88e684d6d3ab9) Thanks [@aoede3](https://github.com/aoede3)! - Renderer v1: declare an app's framework with a required singular `renderer:`

  **BREAKING CHANGE.** Existing apps must migrate (see Migration below): every app now needs a
  `renderer:` field, and any direct `renderStream` caller must move `cspNonce` from the removed
  positional argument onto `opts`. The bump is `minor` because these packages are pre-1.0, where a
  minor is the semver-correct level for a breaking change; it is nonetheless breaking for consumers.

  Every app now declares a REQUIRED singular `renderer:` - an opaque contribution from
  `reactRenderer({ project })` (`@taujs/react/renderer`) or `vueRenderer()`
  (`@taujs/vue/renderer`). `renderer:` is required at runtime: an app without a valid
  renderer fails at boot and build. The `plugins` array returns to meaning ordinary Vite
  plugins only.

  React is a JSX renderer with scoped compiler ownership (the host computes each framework's
  scope after seeing all apps and constructs a correctly-scoped compiler, with a fail-closed
  ownership diagnostic); Vue supplies its `pluginVue` pack fresh per environment without
  ownership machinery. Every declared renderer ships a render module that is
  identity-validated against its declaration (both `renderSSR` and `renderStream` are
  brand-checked - at boot in production, after `ssrLoadModule` in development) with a hard
  error and migration guidance on a mismatch. There is no incomplete-renderer mode.

  The shared render-options bag is now a named `RenderOptions` on both `renderSSR` and
  `renderStream`, carrying `cspNonce` (authoritative; the positional stream argument is
  removed) and the host-resolved `shouldHydrate`, delivered on both rendering strategies.

  Migration:

  - Replace `plugins: [pluginReact()]`/`plugins: [pluginVue()]`-style framework wiring with
    `renderer: reactRenderer({ project: './tsconfig.json' })` / `renderer: vueRenderer()`.
  - Raw `pluginReact()`/`pluginVue()` remain exported and portable for plain-Vite/standalone use.
  - Entry-server files are unchanged: `createRenderer(...)` now brands its returned functions
    so the host can validate framework identity.
  - If you consume `renderStream` directly, pass `cspNonce` via `opts.cspNonce` instead of the
    removed positional argument.

### Patch Changes

- [#28](https://github.com/aoede3/taujs/pull/28) [`d734dc7`](https://github.com/aoede3/taujs/commit/d734dc7cafaa132e7156dd183b6f403dfc3f3bd0) Thanks [@aoede3](https://github.com/aoede3)! - Fix: `__proto__` in route data now round-trips as an ordinary own property

  Route data is injected into the page as `window.__INITIAL_DATA__ = <value>`. That value was
  always emitted as a JavaScript object literal, and in an object literal a quoted `"__proto__":`
  key SETS THE CREATED OBJECT'S PROTOTYPE (ES Annex B.3.1) rather than adding an own property. So a
  route that legitimately returned a `__proto__` key produced a client value whose shape differed
  from the server's: the key was an own property on the server and landed on the prototype in the
  browser, at any depth.

  This was never global prototype pollution - `Object.prototype` was untouched, and it remains
  untouched - but it was silent semantic drift in the single shared serialisation boundary, and
  "the global prototype was not polluted" is not the same guarantee as "the client received the
  value the server sent".

  Now, when a payload contains a `__proto__` key at any depth, the value is emitted as
  `JSON.parse("…")`. `JSON.parse` creates the key as an ordinary own data property at every depth,
  the object's prototype stays `Object.prototype`, and the global prototype is still untouched.
  Breakout escaping is unchanged in both forms.

  Every other payload keeps the object-literal form and is byte-identical to before, so ordinary
  responses and cached pages see no difference. The one exception is a string value exactly equal to
  `"__proto__"`, which also selects the `JSON.parse` form: the two forms are semantically identical,
  so this costs a few bytes and changes nothing observable.

## 0.12.0

### Minor Changes

- [#25](https://github.com/aoede3/taujs/pull/25) [`0e7186c`](https://github.com/aoede3/taujs/commit/0e7186cfa1a257178a629e0bb19f5c3dfa69e185) Thanks [@aoede3](https://github.com/aoede3)! - Declared Vite customisation surface (RFC 0005): one config file owns the whole Vite surface, applied symmetrically to dev and build.

  - `config.vite` - a new first-class field on `taujs.config.ts`, typed as an allowlisted `TaujsViteConfig` (or a `(ctx) => TaujsViteConfig` function form receiving a discriminated serve/build context). Admitted fields (`plugins`, `define`, `css.preprocessorOptions`, `esbuild`, `logLevel`, dev-only `optimizeDeps`, non-`alias` `resolve`, and build tuning such as `build.sourcemap`/`minify`/`rollupOptions.external`/`output.manualChunks`) now reach the shared dev server and every production build through one merge engine and one precedence chain (framework invariants -> `config.vite` -> `taujsBuild({ vite })`).
  - `config.alias` - the declarative home for aliases, sourced by both dev and build. Relative values normalise against the project root; absolute values pass through. The programmatic `createServer({ alias })` and `taujsBuild({ alias })` options remain as escape hatches, layered on top.
  - `configFile: false` is now pinned in both dev and build, so no stray `vite.config.*` is ever auto-discovered. A `vite.config.*` left in a formerly probed location (the client base root or a per-entry root) triggers a targeted migration warning at dev boot and at build start, naming the file and pointing at the `config.vite` recipe. Project-root files were never read and are exempt.
  - Plugin composition rule (dev and build): concatenate in declared order, dedupe by plugin name with the first occurrence winning, and report every cross-source collision once at warn level with the name, each declaring source, and the winner. The `τjs-` framework prefix is reserved - a user plugin carrying it is dropped with a warning. Cross-app plugin collisions in the shared dev server are promoted from debug to warn.
  - Protected-field warnings: supplying a framework-owned field (`root`, `base`, `publicDir`, `configFile`, `server.*`, `appType`, `build.outDir`/`ssr`/`ssrManifest`/`format`/`target`/`manifest`, `rollupOptions.input`, `resolve.alias`) through the override channels is rejected and logged at warn in both dev and build, never silently applied or dropped. The typed `TaujsViteConfig` surface excludes these, so only a JS config or `as any` cast can reach the runtime guard.
  - `optimizeDeps` is a development-only subset (`include`/`exclude`/`esbuildOptions`); the same package in both `include` and `exclude` is a config-validation error, and nothing from `optimizeDeps` reaches production builds.
  - Fix: multi-app builds are now ordered parent-first (root app before named entry points), so a root app declared after a named MFE no longer empties `dist/client`/`dist/ssr` and deletes the MFE's already-emitted output. Per-app `emptyOutDir` behaviour is unchanged. The reorder is ancestry-aware and minimal: an app moves only to sit immediately before the first app whose output directory it contains (ancestry derived from resolved paths, so non-canonical entry points such as trailing-slash parents order correctly). An ancestor moves immediately before its first already-placed descendant, crossing unrelated apps when required; otherwise declared order - which callback and plugin execution observe - is retained, and a collection containing no ancestry relationships is never reordered.

## 0.11.0

### Minor Changes

- [#21](https://github.com/aoede3/taujs/pull/21) [`3e69316`](https://github.com/aoede3/taujs/commit/3e693165c523b598e434eee55acc8a3c8b99735b) Thanks [@aoede3](https://github.com/aoede3)! - RFC 0004 (H1): routes may declare `attr.head = { data, timeoutMs?, optional? }` - a dynamic head
  data loader resolved BEFORE the renderer starts on BOTH strategies and delivered to the renderer
  as `opts.headData` (an additive optional field on the `RenderSSR`/`RenderStream` contracts). This
  gives streamed pages dynamic `<head>` data for the first time; `attr.meta` remains the static
  layer, and head data is never serialised into `__INITIAL_DATA__`.

  Semantics (signed policy): the loader is bounded by `timeoutMs` (default 3000 ms, positive finite
  only - validated at boot); on deadline expiry with the request still live the render proceeds
  with `headData: undefined` plus an advisory log; a caller abort never proceeds into the renderer;
  an ordinary loader rejection fails the request through the existing error path unless the route
  opts in with `optional: true`. On the streaming branch a head failure terminates the hijacked
  reply deterministically (500 before headers, destroy after) instead of rethrowing into a response
  Fastify no longer owns.

  Type inference: `serviceData()` now returns a phantom-branded `ServiceDataHandler<Result>`
  (type-level only - the runtime value is still the honest service descriptor), and the new
  `HeadDataOf<Route>` helper (exported from `@taujs/server/config` with `HeadAttributes`) infers
  the actual selected service method result for `headContent` typing.

## 0.10.0

### Minor Changes

- [#15](https://github.com/aoede3/taujs/pull/15) [`a1a627a`](https://github.com/aoede3/taujs/commit/a1a627a16fdc9aba8b8d33198be053e092c28053) Thanks [@aoede3](https://github.com/aoede3)! - R0-01: export `RenderStreamHandle` (`{ abort(): void; done: Promise<void> }`) as the return
  type of `RenderStream`, and observe `done` at the streaming render call site.

  Both framework renderers already returned `{ abort, done }` at runtime, but the published
  `RenderStream` type promised only `{ abort(): void }`, so the server could not capture `done`.
  A fatal stream error rejects `done`; left unobserved, that surfaced as an `unhandledRejection`
  — which Node's default mode turns into a process-terminating `uncaughtException`. The server
  now captures and acknowledges `done` (fatal errors remain fully handled via the `onError`
  callback; the acknowledgement is also defence in depth if a renderer omits its own handler).

  Type-level breaking change for third-party `RenderStream` implementers: they must now return a
  `done` promise. Both first-party renderers already conform. Bumped `minor` as an additive
  contract type (precedent: V1-05), keeping `@taujs/server` below 1.0.0.

### Patch Changes

- [#15](https://github.com/aoede3/taujs/pull/15) [`1b251fa`](https://github.com/aoede3/taujs/commit/1b251fa10adc055013c9692f8f5c093bcc02ddab) Thanks [@aoede3](https://github.com/aoede3)! - R0-02: origin-aware benign-error classification in `HandleRender`. Replaces the broad
  `REGEX.BENIGN_NET_ERR` substring match (now removed) with a strict socket taxonomy — disconnect
  `code`, `AbortError` name, or exact node/undici socket message.

  Fixes a hung-request hole: a `renderSSR` failure is render-origin, so it is benign only when the
  request was actually aborted. A disconnect-shaped render error on a live request previously
  returned silently without sending a response (hanging the request); it now produces a real 500.
  Socket-origin paths (send failure, PassThrough/HTTP socket errors, stream `onError`) use the same
  strict socket check, so an application error whose message merely contains "aborted"/"premature"
  is no longer mistaken for a client disconnect.

- [#15](https://github.com/aoede3/taujs/pull/15) [`d629017`](https://github.com/aoede3/taujs/commit/d629017837553f2b0196aed330cd975edc581689) Thanks [@aoede3](https://github.com/aoede3)! - R0-04: eliminate the second process-crash class — a `JSON.stringify` failure thrown from the
  streaming `finish` listener, which runs on a stream tick OUTSIDE the request `try/catch`, so an
  uncaught throw becomes an `uncaughtException` → process exit.

  A single server-owned `serializeInlineData` boundary now serializes the inline
  `window.__INITIAL_DATA__` script for BOTH render modes. It escapes `<` (output is byte-identical
  to the previous inline expression for every valid input, so cached pages are unaffected), treats
  circular references, `BigInt`, a throwing `toJSON`, and `undefined` as deterministic failures, and
  NEVER throws. The SSR path throws an `AppError.internal` into the existing 500 machinery on
  failure; the streaming path logs, records (`recorder.failed`), and terminates the response
  deterministically without a data script — with the entire listener wrapped in a `try/catch` belt.
  The JSON data contract is unchanged (no new serializer dependency).

- [#15](https://github.com/aoede3/taujs/pull/15) [`55ace30`](https://github.com/aoede3/taujs/commit/55ace30371dccde96cc8151c17ec838a11c3b700) Thanks [@aoede3](https://github.com/aoede3)! - R0 gate recheck fix — a throwing host `onError` callback can no longer veto stream
  cleanup/settlement:

  - **Renderers** (`@taujs/react`, `@taujs/vue`): every fatal path now routes through a single
    helper that invokes the host `onError` under `try/catch` (the throw is logged and swallowed) and
    ALWAYS runs `controller.fatalAbort`. So a throwing callback — or one called from a shell timer or
    a writable EventEmitter listener — can neither skip cleanup / `done` settlement nor escape as an
    `uncaughtException`; the ORIGINAL render error stays the rejection reason. React additionally no
    longer double-fires `onError` for a fatal writable error.
  - **Server** (`@taujs/server`): the streaming render `onError` callback is now non-throwing for an
    arbitrary/hostile `unknown`. Telemetry (message / kind / normalise / reason) is extracted through
    safe, never-throwing helpers and belted, so formatting a hostile error (a throwing `message`
    getter or `Symbol.toPrimitive`) can no longer prevent the deterministic response teardown
    (500 / socket destroy).

- [#15](https://github.com/aoede3/taujs/pull/15) [`9bbc4b7`](https://github.com/aoede3/taujs/commit/9bbc4b70ee9ab069bd8688338018cace9b753a2d) Thanks [@aoede3](https://github.com/aoede3)! - R0 gate-review fixes:

  - **Server:** the streaming render `onError` is the renderer's FATAL channel and is now trusted —
    benign classification uses ACTUAL request-abort state, not the shape (`code`/`name`/exact
    message) of an application-controlled error. This closes an origin-blind reclassification at the
    renderer/server join: a render/data failure that happens to look like a disconnect (e.g.
    `code: 'EPIPE'`, `name: 'AbortError'`, or the exact message `"aborted"`) now enters the failure
    path and is recorded, instead of being silently treated as a client disconnect.
  - **Renderers** (`@taujs/react` upstream, `@taujs/vue` byte-identical drift-copy): the shared UI
    logger is now NON-THROWING — formatting arbitrary `unknown` values (`BigInt`, circular objects,
    symbols, a throwing `toJSON`/`Symbol.toPrimitive`) and calls to a user-provided logger method are
    isolated, so a diagnostic on an error path can never break control flow. The stream controller
    additionally cleans up and settles `done` even if its logger throws. Together these make R0-03's
    always-on `warn`/`error` safe for arbitrary thrown values.

- [#15](https://github.com/aoede3/taujs/pull/15) [`caaa160`](https://github.com/aoede3/taujs/commit/caaa160636e807d7d495180e3284f80345d59323) Thanks [@aoede3](https://github.com/aoede3)! - R1-01: add the additive `onRenderError` render-error contract and propagate the request
  `AbortSignal` into route data resolution.

  - **`RenderErrorInfo` + `onRenderError`** are added to the exported `RenderCallbacks` contract. This
    is the advisory, NON-FATAL structured render-error channel (notably for post-shell boundary errors
    the renderer recovers client-side). The server wires it to the request logger at `warn` with a
    message keyed on `recoverable` (`phase`/`recoverable`/`clientRoot`/`url` as structured fields), so a
    recoverable render error is surfaced without being escalated to a fatal response and without
    double-logging a pre-shell error at `error` level (the fatal channel owns that). Callback-policy
    JSDoc documents which callbacks are fatal vs advisory.
  - **AbortSignal into data context.** The request `AbortController.signal` is now threaded into the
    data-resolution context for both the SSR and streaming branches, so loaders can observe client
    disconnects — proven end-to-end by a test that fires the streaming disconnect handler and asserts
    the loader's `ctx.signal.aborted` flips. Non-throwing error formatting on the logging path is
    preserved.

  `onRenderError` is OPTIONAL and non-breaking in either direction (unlike R0-01's `RenderStream`
  return-type change), so existing `RenderCallbacks` users are unaffected — `patch` per the R1-01
  changeset plan, keeping `@taujs/server` below 1.0.0.

- [#15](https://github.com/aoede3/taujs/pull/15) [`952afd0`](https://github.com/aoede3/taujs/commit/952afd04feaf990c256d493ea17c1b7236b4a9a7) Thanks [@aoede3](https://github.com/aoede3)! - R2-02 (SEC2): attribute-escape the bootstrap-module `src` at both server emission sites.

  A new server-local `escapeHtmlAttribute` (the server is renderer-agnostic and does not import the
  renderers' `escapeHtml`) now escapes the config-controlled bootstrap-module URL where it is
  interpolated into a `<script … src="…">` tag — the SSR-path tag in `HandleRender` AND
  `injectBootstrapModule` in `Templates` (used by the not-found path). Defence-in-depth: the value is
  config-controlled, so a normal module URL is unchanged; this closes the raw-attribute interpolation.
  `patch` per the versioning cap (no server major/minor for this).

## 0.9.1

### Patch Changes

- [#13](https://github.com/aoede3/taujs/pull/13) [`5ffd5b8`](https://github.com/aoede3/taujs/commit/5ffd5b8f938b12d27b5ec91a16003201c677fa49) Thanks [@aoede3](https://github.com/aoede3)! - Fix Vue streaming routes rendering the app twice in dev. The dev introspection stamp
  was written as the first child of `#root` (before the streamed app HTML), which Vue
  hydration reports as a node mismatch - it re-renders the whole app as a duplicate
  sibling of the server-rendered tree. The stamp now lands in `<head>` on the streaming
  path. React is unaffected either way (its hydration skips unexpected scripts) and was
  verified against both playgrounds; production HTML never carried the stamp. The ssr
  path (stamp after the app HTML, tolerated by both renderers) is unchanged.

## 0.9.0

### Minor Changes

- [#10](https://github.com/aoede3/taujs/pull/10) [`ff2db9a`](https://github.com/aoede3/taujs/commit/ff2db9aebfe3da2cd987dbfab6c8da0141150608) Thanks [@aoede3](https://github.com/aoede3)! - Export the render-contract types for framework renderer packages (V1-05):
  `RenderCallbacks`, `RenderSSR`, `RenderStream`, `RenderModule`, `RendererLogger`.
  Framework packages (e.g. `@taujs/vue`) can now type-check their `createRenderer(...)`
  output against `RenderModule` cast-free. `RenderStream`'s sink parameter is typed as a
  node `Writable` (which the server has always passed as a `PassThrough`, and both renderers
  have always consumed), and `opts.logger` on `RenderSSR`/`RenderStream` uses the new minimal
  `RendererLogger` structural type in place of the internal `Logs`. Additive and
  backward-compatible; the previously-unexported `StreamSink` type is removed.

## 0.8.0

### Minor Changes

- [#6](https://github.com/aoede3/taujs/pull/6) [`b82056a`](https://github.com/aoede3/taujs/commit/b82056a7667a06dd6dd64e9f3ca436221952242b) Thanks [@aoede3](https://github.com/aoede3)! - P0A-03: add `createRequestGraph(config, { source, emittedAt, serviceRegistry? })` — a pure, deterministic, no-I/O serialisation of the resolved config into request-graph schema v1: apps, routes (effective render/hydrate values with `defaulted` flags, specificity, conservative auth/CSP blocks, declared `data.kind`), services with declared param/result schema kinds and `usedBy` edges when a registry is supplied (`null` otherwise), security summary, fallthrough model, and a structured warnings registry. Declared route → service edges are read via the P0A-01/P0A-02 metadata accessors — no data handler is ever executed. Exported from the package root.

- [#6](https://github.com/aoede3/taujs/pull/6) [`c52b80b`](https://github.com/aoede3/taujs/commit/c52b80b72c13fc9acbd6b170f4bf7fbc24bbadc3) Thanks [@aoede3](https://github.com/aoede3)! - P0B-03: dev introspection files, overlay endpoints, and the `introspection` config surface. Dev boot now writes `node_modules/.taujs/dev.json` (bootId, per-boot token, pid, actual bound socket, artifact paths — removed on graceful close) and mirrors the in-memory rings to `traces.ndjson` / `logs.ndjson` / `observations.json` with atomic non-fatal writes. `/__taujs/graph|observations|traces` (plain + SSE) and `POST /__taujs/beacon` are registered only inside the structural dev gate, each enforcing loopback remote-address → Host validation (DNS-rebinding safe) → per-boot token, in that order. New public config: `introspection.allowNonLoopback` (relaxes only the remote-address check and shouts in the boot summary) and `introspection.redaction.denyKeys`/`replaceDefaultDenyKeys`.

- [#6](https://github.com/aoede3/taujs/pull/6) [`fb34d5f`](https://github.com/aoede3/taujs/commit/fb34d5f0d5ef2e2f121ac91ff219e8fa5c13150b) Thanks [@aoede3](https://github.com/aoede3)! - P0A-04: wire request-graph emission. Dev boot writes `node_modules/.taujs/graph.json` (`source: 'boot'`, registry-enriched) from a Fastify `onListen` hook — registered only inside the structural development gate via lazy dynamic import, so production never loads the introspection code at all. `taujsBuild` writes `dist/.taujs/graph.json` (`source: 'build'`, `services: null`) after successful builds. All artifact writes go through a shared `writeTaujsArtifact` helper: directory ensured, atomic tmp+rename, and non-fatal by contract — a failure warns once per boot and never breaks boot or build.

- [#6](https://github.com/aoede3/taujs/pull/6) [`2368d09`](https://github.com/aoede3/taujs/commit/2368d09619aa1b89d4f0fb9546b48925dde61526) Thanks [@aoede3](https://github.com/aoede3)! - P0A-01: add `createServiceData()` / `serviceData()` — typed sugar over the service-descriptor best practice. The returned handler is an ordinary async `DataHandler` that builds the `ServiceDescriptor` at request time (runtime dispatch through `fetchInitialData` is unchanged) and carries non-enumerable `{ serviceName, serviceMethod }` metadata readable via the internal `getServiceDataMetadata()` accessor, so tooling can see declared route → service edges without executing handlers. Exported from `@taujs/server/config` alongside `defineService`.

- [#6](https://github.com/aoede3/taujs/pull/6) [`6f557bd`](https://github.com/aoede3/taujs/commit/6f557bdd2fd49c1f4c5b4af9ec020933aebac7a1) Thanks [@aoede3](https://github.com/aoede3)! - P0B-01: trace context is now created in a shared `onRequest` hook (registered deliberately before the auth hook), so every request — rendered, fallthrough, or asset-like — has a `traceId` before route matching. Behaviour addition: fallthrough (client-rendered) responses now carry the `x-trace-id` response header, and fallthrough logs carry the request's trace context. Rendered-route behaviour is observably unchanged; `handleRender`/`handleNotFound` invoked without the hook (direct composition) behave exactly as before.

- [#6](https://github.com/aoede3/taujs/pull/6) [`0bf8d9b`](https://github.com/aoede3/taujs/commit/0bf8d9b7adec50ae1292f02971a3ba9b4407ced4) Thanks [@aoede3](https://github.com/aoede3)! - P0B-02: `TraceRecorder` interface (no-op default) with a dev-only ring-buffer assembler behind the structural gate. Rendered, fallthrough, failed, and aborted requests each assemble a trace record (200-trace ring) with URL hygiene — pathname + surviving query key names only, denylisted keys dropped entirely, values never stored. The request child logger is teed into a logs annex (2000-record ring, debug excluded, redaction-filtered meta), and observed service edges accumulate into an observations document (shapes deferred — the `serviceCall` event deliberately never carries result data). Recorder calls are synchronous fire-and-forget and safety-wrapped: a throwing recorder implementation warns once and never affects a response.

### Patch Changes

- [#6](https://github.com/aoede3/taujs/pull/6) [`f7035b6`](https://github.com/aoede3/taujs/commit/f7035b6e8b037e246e4a5c91c305ad30b58db81f) Thanks [@aoede3](https://github.com/aoede3)! - P0A-02: `defineService` now retains the declared schema shape of each normalised method as non-enumerable metadata — `{ params, result }`, each `{ declared, kind? }` where `kind` is `'parse' | 'function'` (the only distinction `NarrowSchema` honestly reveals; never claimed as "zod"). Bare-function and schemaless entries record `{ declared: false }`. Runtime behaviour is unchanged: `runSchema` dispatch, container freezing, and method identity are all as before; the metadata is readable only via the internal `getServiceMethodMetadata()` accessor (exported from `@taujs/server/config`), so tooling can see declared param/result schemas without executing handlers.

- [#6](https://github.com/aoede3/taujs/pull/6) [`bc98103`](https://github.com/aoede3/taujs/commit/bc981030836f811028518b0d2c471e3d04c1c5b9) Thanks [@aoede3](https://github.com/aoede3)! - P0B-04: dev boots stamp `window.__TAUJS_TRACE_ID__` + the per-boot token and inject the beacon script (nonce-aware) into rendered pages — alongside `__INITIAL_DATA__` on SSR, in the head write on streaming, and into the fallthrough shell, which has no data script to ride with. The script listens to `hydrateApp`'s internal events and POSTs `{ traceId, ok, ms?, error? }` to `/__taujs/beacon` once, with the token header. Present only when the structural dev gate holds; production HTML never carries any of it.

## 0.7.1

### Patch Changes

- [#2](https://github.com/aoede3/taujs/pull/2) [`5f0720c`](https://github.com/aoede3/taujs/commit/5f0720c30d6cf5e19ff453b060f784eaa3730428) Thanks [@aoede3](https://github.com/aoede3)! - Declare `picocolors` as a dependency. It is imported at runtime (logging, network, and server bootstrap) but was previously undeclared and resolved only via package hoisting — which fails under pnpm's strict `node_modules` layout and for consumers installing the package on its own.

v0.7.0 - 06/07/2026

fix: fastify is a peer dependency again
chore: constructible mocks use function implementations
fix: AppError identity survives duplicate class copies

v0.6.6 - 06/07/2026

fix: no success log when the auth decorator sends its own rejection
fix: CSP error path fails closed for routes that declared CSP
docs: state the auth enforcement boundary in the hook
chore: surface dropped duplicate plugins; tidy contract report; document SPA fallback
refactor: one route-specificity algorithm
fix: streaming commits status on first output, 500s on early failure
fix: no dev-grade CSP fallback in production
fix: fail boot when SSRServer registration throws
fix: asset short-circuit tests the pathname, not the full URL
fix: restore stem semantics for defaultEntryClient
fix: per-request CSP nonce; never mutate shared directives

v0.6.5 - 29/06/2026

chore(deps): bump vite from 7.3.2 to 7.3.6
chore(deps-dev): bump @babel/core from 7.28.5 to 7.29.7
chore(deps-dev): bump form-data from 4.0.5 to 4.0.6
chore(deps-dev): bump vitest, @vitest/coverage-v8 and @vitest/ui
feat: aligning alias / baseClientRoot

v0.6.4 - 10/05/2026

chore(deps): bump fast-uri from 3.1.0 to 3.1.2
chore(deps): bump postcss from 8.5.6 to 8.5.14

v0.6.3 - 16/04/2026

chore(deps): bump @fastify/static from 8.3.0 to 9.1.3

v0.6.2 - 16/04/2026

chore(deps): bump fastify from 5.8.3 to 5.8.5
chore(deps): bump fastify from 5.6.1 to 5.8.5

v0.6.1 - 05/04/2026

chore(deps): bump vite from 7.3.1 to 7.3.2

v0.6.0 - 05/04/2026

feat: type augmentation
feat: type augmentation prettier

v0.5.9 - 05/04/2026

chore(deps): bump fastify from 5.7.3 to 5.8.3
chore(deps): bump brace-expansion
chore(deps): bump path-to-regexp from 8.3.0 to 8.4.0
chore(deps-dev): bump flatted from 3.3.3 to 3.4.2
chore(deps-dev): bump picomatch from 2.3.1 to 2.3.2

v0.5.8 - 27/02/2026

chore(deps): bump rollup from 4.53.3 to 4.59.0
chore(deps): bump ajv from 8.17.1 to 8.18.0
chore(deps): bump fastify from 5.6.2 to 5.7.3
chore(deps): bump @isaacs/brace-expansion from 5.0.0 to 5.0.1
chore(deps): bump minimatch

v0.5.7 - 22/01/2026

feat: consolidate template utilities
chore: consolidate template utilities - formatting

v0.5.6 - 14/01/2026

feat: streaming vite plugins; hmr; tests
chore: update packages

v0.5.5 - 11/01/2026

feat: remove resolve route data

v0.5.4 - 04/01/2026

feat: core
feat: core tests
feat: logging, constants
feat: logging, constants, resolver
feat: core orchestration
feat: build / asset management; tests
feat: core types

v0.5.3 - 29/12/2025

feat: rename \_\_taujs/data to \_\_taujs/route as explicit route data contract

v0.5.2 - 19/12/2025

feat: align streaming ownership boundary to template

v0.5.1 - 17/12/2025

feat: plugin alignment
feat: .ts, .tsx file extensions for entry points

v0.5.0 - 11/12/2025

feat: update path resolution

v0.4.9 - 03/12/2025

feat: static assets dev/prod; default paths, prod serving

v0.4.8 - 02/12/2025

feat: build types readonly

v0.4.7 - 01/12/2025

test: RouteContext streaming test
feat: RouteContext; tests

v0.4.6 - 25/11/2025

chore: update packages; clean
feat: remove FastifyStatic dependancy; test

v0.4.5 - 24/11/2025

feat: serviceRegistry change to optional; tests
feat: Build isolated app; tests
test: Logger coverage in hasMeta

v0.4.4 - 23/11/2025

feat: logger wrap strings; tests

v0.4.3 - 23/11/2025

feat: ctx.call functionality
feat: Logging fixes for logging: false; Updates to abort logging
feat: Build system; user vite configuration; ssr manifest isolation; tests
feat: render logging; barrel exports; tests
feat: RouteData; \_\_taujs/data route; tests
feat: align HandleRender / Logger; tests

v0.4.2 - 04/11/2025

feat: CSP reporting
feat: auth routeMeta; decorator
feat: Logger; silent Pino
feat: ServiceDescriptor standardisation
feat: CSP plugin cleanup; test
feat: DataServices cleanup; test
test: CreateServer coverage

v0.4.1 - 25/10/2025

feat: Focus on Pino as first class logger; associated files, tests
feat: Add friendly attr.data error; suppress duplicate errors when already logged by component
feat: tightening api surface
chore: update vite-plugin-node-polyfills
feat: static asset registration; tests

v0.4.0 - 20/10/2025

chore: update vite
chore: update packages vite; vitest; tests
feat: HandleNotFound logger
feat: onHead raw.write callback return
chore: sorting import hierarchy
feat: csr rendering; tests
chore: package updates
feat: Associated file updates; tests; project details
feat: Associated file updates; tests; project details
feat: Logger; AppError, Parser; associated file updates
feat: Logger; associated file updates
feat: csp routes; observability
feat: createConfig; network; banner; debug
feat: CreateServer; logging; verification; startup; types
feat: Logging / Telemetry
feat: file splitting; optimisation
feat: file splitting; optimisation
feat: data; services, schema addition

v0.3.7 - 16/08/2025

chore(deps): bump tmp and @changesets/cli
feat: csp test types
feat: csp updates; plugin; tests

v0.3.6 - 22/07/2025

chore(deps-dev): bump form-data from 4.0.3 to 4.0.4

v0.3.5 - 16/07/2025

sec: env; remove await; tests

v0.3.4 - 16/07/2025

sec: fastify dependencies static

v0.3.3 - 16/07/2025

sec: fastify dependencies

v0.3.2 - 15/07/2025

sec: fetch network access; typing; tests
feat: rename fetch to data
sec: fetch network access; types

v0.3.1 - 10/07/2025

feat: url matching; test; cleanup

v0.3.0 - 10/07/2025 - Orchestration Foundations

- Introduced middleware as an orchestration-layer primitive
- Added attribution notice and clarified τjs [ taujs ] system scope
- Consolidated route and config handling under `taujs.config.ts`
- Moving toward a formal build-time orchestration model

feat: middleware intro; auth; tests; cleanup
feat: taujs.config
feat: selective hydration; types; constants; tests
feat: attribution

v0.2.9 - 08/07/2025

feat: middleware intro; auth; tests; cleanup

v0.2.8 - 07/07/2025

feat: taujs.config
feat: selective hydration; types; constants; tests

v0.2.7 - 05/07/2025

feat: SSRServer clean up typing
feat: utils; service method typing
test: utils service method coverage

v0.2.6 - 03/07/2025

feat: Security csp dev standard

v0.2.5 - 03/07/2025

feat: Security csp
test: Security csp
test: build
feat: Security csp

v0.2.4 - 01/07/2025

feat: service typing; cleanup

v0.2.3 - 30/06/2025

feat: Integrate build; tsup config; clean up package.json;
chore: update to node 22.17.0
feat: defer dynamic module injection

v0.2.2 - 17/06/2025

chore(deps): bump brace-expansion from 2.0.1 to 2.0.2

v0.2.1 - 10/07/2025

feat: split renderer to own package
chore: update vite 6.3.5

v0.2.0 - 09/07/2025

chore: update vite 6.3.5

v0.1.9 - 09/07/2025

test: Vite createViteRuntime -> ssrLoadModule
chore: Update Fastify 5.2.0 --> 5.3.3
feat: Introducing picolors and associated messaging
chore: Update Vite 5.4.2 -> 6.3.5

v0.1.8 - 24/01/2025

chore(deps-dev): bump vite from 5.4.7 to 5.4.14
chore(deps-dev): bump vite from 5.4.7 to 5.4.14 - release

v0.1.7 - 19/12/2024

chore: Update React to v19 + associated packages

v0.1.6 - 17/12/2024

chore: Update Fastify + associated packages

v0.1.5 - 12/12/2024

feat: Micro-frontend; processConfigs utill; testing; CHANGELOG; README
feat: Micro-frontend; testing; utils
feat: Micro-frontend; server orchestration; utility alignment

v0.1.4 - 02/12/2024

fix: ssr css and preload links in header

v0.1.3 - 22/22/2024

chore(deps): bump cross-spawn and @changesets/cli
chore: Update README; cleanup debug

v0.1.2 - 08/11/2024

release: 0.1.2; type change; audit, cleanse; ReadMe update

v0.1.1 - 31/10/2024

feat: SSRHydration createRoot + hydrateRoot; tests; vite css modern; clearup

v0.1.0 - 31/10/2024

fix: fastify dependency change to 4.28.1 compatibililty between static/compress

v0.0.9 - 31/10/2024

Merge branch 'integrate-spa-ssr' Integrated @taujs/server SPA, SSR, Streaming SSR, SSRDataStore; Hydration

v0.0.8 - 03/10/2024

Merge branch 'integrate-hydration' SSRHydration; Logger; updated build, package

v0.0.7 - 23/09/2024

Optional 'alias' on plugin registration
CI @testing-library/dom for 'screen'

v0.0.6 - 21/09/2024

Fastify upgrade 4.28.0 to 5.0.0; test suite; cleanup

v0.0.5 - 12/09/2024

path-to-regex upgrade 7.0.0 to 8.1.0
path-to-regexp outputs backtracking regular expressions - https://github.com/advisories/GHSA-9wv6-86v2-598j

v0.0.4 - 08/09/2024

SSRRender readme

v0.0.3 - 08/09/2024

SSRRender; tsup config

v0.0.2 - 08/09/2024

Custom alias

v0.0.1 - 07/09/2024

Initial taujs-server
