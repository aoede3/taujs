# @taujs/vue

## 0.5.0

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

## 0.4.0

### Minor Changes

- [#21](https://github.com/aoede3/taujs/pull/21) [`567ac68`](https://github.com/aoede3/taujs/commit/567ac68a7d4c258ebe229dad768070658eb8e976) Thanks [@aoede3](https://github.com/aoede3)! - RFC 0004 (H6, adoption signed): `headContent` receives the route's resolved `attr.head` payload
  as `headData?: H` - vue's single, pre-render head build (timing unchanged, by design) can now see
  dynamic data on BOTH strategies, closing the gap where the renderer-agnostic `attr.head` route
  config was silently dead on vue. `createRenderer` gains a defaulted third generic
  (`createRenderer<T, R, H>`; existing call sites compile unchanged) and `HeadContext` gains the
  optional `headData` field beside the untouched `data: T`. `headData` is `undefined` when the
  route declares no `attr.head` and when the head loader degraded under the server's signed
  policy, so handle it (typically by falling back to `meta`); escape `headData`-derived values
  with `escapeHtml`.

  Contract regularisation (the react H2 model): the render functions' contract-facing parameter
  types are now honestly broad with documented internal narrowing seams, and the conformance type
  test additionally instantiates NON-default generics - closing vue's own latent
  strictFunctionTypes assignability gap that the default-only test masked.

## 0.3.0

### Minor Changes

- [#15](https://github.com/aoede3/taujs/pull/15) [`1ce47a8`](https://github.com/aoede3/taujs/commit/1ce47a8516d22217b02463549d5beb0a2df2aff0) Thanks [@aoede3](https://github.com/aoede3)! - R2-02: export `escapeHtml` and document the `headContent` raw-HTML contract.

  - **New export `escapeHtml(value)`** (from the package root) — escapes the five HTML-sensitive
    characters (`& < > " '` → `&amp; &lt; &gt; &quot; &[#39](https://github.com/aoede3/taujs/issues/39);`), text- AND attribute-safe (single- and
    double-quoted). Non-string input is coerced via `String(value)`. Byte-identical to `@taujs/react`'s
    helper (enforced by the utils drift guard).
  - **`headContent` contract JSDoc** on the `createRenderer` option and `HeadContext`: the return value
    is written into `<head>` as RAW HTML and is intentionally NOT auto-escaped, so any value
    interpolated from services/user input must be escaped with `escapeHtml`.

  No render-path behaviour change. `minor` for the additive export.

### Patch Changes

- [#15](https://github.com/aoede3/taujs/pull/15) [`622160f`](https://github.com/aoede3/taujs/commit/622160f469c14dccfe5bb72e74c5636f440015c3) Thanks [@aoede3](https://github.com/aoede3)! - R0-01: make `renderStream().done` crash-safe by default - a byte-identical drift-copy of the
  `@taujs/react` fix (`utils/Streaming.ts` is kept in sync by the drift guard).
  `createStreamController` pre-attaches a no-op rejection handler so an unobserved `done` can
  never crash the process (via `unhandledRejection` → `uncaughtException`) when a stream aborts
  fatally; consumers who `await done` still receive the error. Mirrored child-process regression
  test included.

- [#15](https://github.com/aoede3/taujs/pull/15) [`726ae14`](https://github.com/aoede3/taujs/commit/726ae143252b33e45bca51519115d0f3380c73eb) Thanks [@aoede3](https://github.com/aoede3)! - R0-02: origin-aware benign-error classification (byte-identical drift-copy of the `@taujs/react`
  `Streaming.ts` change). `isBenignStreamErr(err, source)` treats only socket/writable-origin
  errors (by `code`, `AbortError` name, or exact socket message) as benign disconnects; the sink's
  `destroy` path is render-origin and so is never benign by shape. Real client disconnects continue
  to be handled benignly via the writable guards ('socket') and the AbortSignal.

  Interim behaviour: a render-origin disconnect-lookalike now routes to the fatal path instead of
  being silently dropped.

- [#15](https://github.com/aoede3/taujs/pull/15) [`052bcf9`](https://github.com/aoede3/taujs/commit/052bcf99e0d75f94f9f0b176d6c20e624d892b72) Thanks [@aoede3](https://github.com/aoede3)! - R0-03: `enableDebug` now gates only log VERBOSITY, not error visibility (byte-identical
  drift-copy of the `@taujs/react` `Logger.ts` change). `createUILogger`'s `warn` and `error`
  always route — to the provided logger if any, else `console`; only `log` is silenced when
  `enableDebug` is false. `createVueErrorHandler` therefore now reports Vue errors to the logger
  even without debug enabled.

  **Behaviour change:** production consumers that did not enable debug will now see renderer
  warnings and errors (Vue errors, data-promise rejections, callback errors, missing root element,
  hydration warnings) on their logger/console. This is the intended observability fix (RFC S2), not
  a regression. Call sites explicitly wrapped in `if (enableDebug)` remain debug-only.

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

- [#15](https://github.com/aoede3/taujs/pull/15) [`0290170`](https://github.com/aoede3/taujs/commit/02901706062342824319c0825e01b9da775cf109) Thanks [@aoede3](https://github.com/aoede3)! - R2-03: close the two vue-side sweep items (twin of react's R2-01/R2-02).

  - **Missing root is now reported.** A missing root element in `hydrateApp`'s bootstrap previously
    logged and returned silently; it now also emits a `hydration:error` beacon and calls
    `onHydrationError` (mirroring react's R2-01). It emits an error WITHOUT a preceding `hydration:start`
    (hydration never began; vue already does this for a setupApp failure). The `onHydrationError` call is
    isolated so a throwing observer cannot escape bootstrap.
  - **Bootstrap attributes are escaped (SEC2).** The manually-written streaming bootstrap `<script>` now
    passes its `src` (bootstrapModules) and `nonce` (cspNonce) through the shared `escapeHtml`.
    Defence-in-depth: `escapeHtml` is a no-op on clean module URLs and base64 nonces, so the tag is
    byte-unchanged for valid input.

  No behaviour change on the success path. Vue's existing hydration-phase/single-settlement machinery is
  unchanged (the missing-root case precedes it).

- [#15](https://github.com/aoede3/taujs/pull/15) [`3e7e34b`](https://github.com/aoede3/taujs/commit/3e7e34bc50ce6d2b2aa57eb11a2ac3b80c6ad8ab) Thanks [@aoede3](https://github.com/aoede3)! - Gate R2 review: fix four Vue lifecycle defects that the React hardening work had already fixed but
  which were never backported. No change on any success path.

  - **A fatal stream error can no longer be downgraded to a benign completion.** `fail` now claims the
    terminal fatal state (`controller.fatalAbort`) BEFORE invoking the host `onError`. The server's
    `onError` synchronously calls `ac.abort()`, and that same `AbortSignal` is wired to the renderer's
    benign-cancel path, so the callback-first ordering let the re-entrant benign abort win the one-shot
    controller and RESOLVE `done` for a fatal render failure, breaking the `RenderStreamHandle` contract.
  - **A throwing `onHead` is now fatal, not advisory.** `onHead` is operationally required: at the server
    boundary it commits the response prefix and connects the renderer's stream to the HTTP response. Vue
    previously warned and carried on, writing application bytes into an unconnected sink and yielding a
    malformed "successful" response with no head or body. It now enters the fatal path, stops before
    rendering, and `done` rejects with the callback error (parity with React).
  - **Hydration observers are isolated.** `onStart` / `onSuccess` / `onHydrationError` throws are logged
    and swallowed everywhere (hydrate, CSR, missing-root). Previously a throwing `onStart` was misread as
    a hydration failure and PREVENTED the app mounting; a throwing `onSuccess` manufactured a
    `hydration:error` for an attempt that had already emitted `hydration:success`; and a throwing
    `onHydrationError` escaped `hydrateApp` from inside a catch block.
  - **Final-data observers are isolated independently.** A throwing `onAllReady` or `onFinish` no longer
    reaches the data-rejection path (turning resolved data plus a completed render into a fatal stream
    failure), and a throwing `onAllReady` no longer suppresses the legacy `onFinish` alias.

- [#15](https://github.com/aoede3/taujs/pull/15) [`4dda857`](https://github.com/aoede3/taujs/commit/4dda857432473f2b8ccefe72c9e5e43e8b4c2d2b) Thanks [@aoede3](https://github.com/aoede3)! - R3-01: peer contract corrections and a strengthened contract conformance test.

  - **Peer contract corrected.** `vue` is now a REQUIRED peer alongside `@vue/server-renderer` (it was
    marked optional, yet the root entry imports it). Tooling peers (`vite`, `typescript`,
    `@vitejs/plugin-vue`) remain OPTIONAL, with ranges widened so they no longer reject working setups:
    `vite` `^7.0.0` (was `^7.1.9`), `typescript` `^5.5.0`, `@vitejs/plugin-vue` `^5.0.0 || ^6.0.0`. NB
    `peerDependenciesMeta.optional` permits a peer to be ABSENT; it does NOT relax its version range when
    the peer is present.
  - **`@types/node` is now declared** as an optional peer - the published root `.d.ts` references
    `node:stream` (the `renderStream` sink), which was previously an undeclared type dependency.
  - `"sideEffects": false`.
  - **Contract test strengthened** (test-only): `contract.test-d.ts` now pins the `renderStream` RETURN
    shape against `RenderStreamHandle` in both directions, derived from the CONCRETE renderer output
    rather than the contract-typed alias (deriving it from the annotated module made the assertion a
    tautology). Catches a contract weakening the plain module assertion tolerates.

  No runtime source change.

- [#15](https://github.com/aoede3/taujs/pull/15) [`4b22613`](https://github.com/aoede3/taujs/commit/4b22613fd75e04d5d8a02e01277685e51a65d355) Thanks [@aoede3](https://github.com/aoede3)! - R3-05 (Q6): the dist now preserves the source module graph (explicit `.js` specifiers + unbundled
  build), matching `@taujs/react`. For vue this is structural hardening, not a defect fix - client
  bundles already tree-shook `@vue/server-renderer` to ~0 bytes; the unbundled graph removes the
  latent dependence on that build staying tree-shakeable. A module-graph guard test now pins the
  absence (builds a real production browser bundle of the client entry and asserts zero rendered
  `@vue/server-renderer` bytes), plus a specifier-extension lint test. No API change.

- [#15](https://github.com/aoede3/taujs/pull/15) [`4190023`](https://github.com/aoede3/taujs/commit/4190023ce955420f009ef40096fe76f39f5ea404) Thanks [@aoede3](https://github.com/aoede3)! - R3-07 (S1): harden the public `ready` promise against unhandled rejections. A user-constructed
  store (`createSSRStore` is public API) whose loader rejects and whose `ready` is never observed
  previously produced an `unhandledRejection` - a process-terminating crash under Node's default
  mode. A no-op rejection handler is now pre-attached at creation; `await store.ready` still
  rejects with the loader error for consumers who observe it, and a recovering `setData` leaves
  `ready` rejected (promises settle once - now pinned by tests). Regression proven in a child
  process under default rejection flags (the R0-01 methodology).

- [#15](https://github.com/aoede3/taujs/pull/15) [`7a1531d`](https://github.com/aoede3/taujs/commit/7a1531d161e49e6da9563e0ebd87db24e756e6ad) Thanks [@aoede3](https://github.com/aoede3)! - R3-08 (S2, twin of the react fix): an explicit `setData` now supersedes the store's in-flight
  initial promise. Previously a LATE loader rejection flipped `status` to `'error'` (contradicting
  the explicitly-set data in every reactive consumer, with a misleading "Failed to load initial
  data" log) and a late loader resolution silently overwrote `data.value`. Both settlements are now
  ignored once `setData` has run. `ready` semantics are unchanged (`setData` already resolved it).

## 0.2.0

### Minor Changes

- [#10](https://github.com/aoede3/taujs/pull/10) [`609cece`](https://github.com/aoede3/taujs/commit/609ceceb4f62263f6714a303447166bdc17aba61) Thanks [@aoede3](https://github.com/aoede3)! - First release of `@taujs/vue` (V2-01): framework-agnostic Vue SSR primitives — the
  transport layer for server-side rendering and hydration, sharing the τjs render-surface and
  streaming protocol. Provides `createRenderer` (`renderSSR` + in-order streaming
  `renderStream`), a Vue-native SSR data store (`createSSRStore`, `useSSRData`,
  `useSSRDataAsync` under `<Suspense>`, `useSSRStore`, `useSSRReady`, `useSSRStatus`),
  `hydrateApp` with hydration-error handling and a DevTools beacon twin, `setupApp` app-instance
  customization on every render/mount path, `<Teleport>` collection on `renderSSR`, and
  `pluginVue` (via `@taujs/vue/plugin`). Standalone and runtime-agnostic; ESM-only.
