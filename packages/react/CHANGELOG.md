# @taujs/react

## 0.3.0

### Minor Changes

- [#15](https://github.com/aoede3/taujs/pull/15) [`b1fa96e`](https://github.com/aoede3/taujs/commit/b1fa96e04b3e3dc57180f1e59460159074ce7ca9) Thanks [@aoede3](https://github.com/aoede3)! - R2-02: export `escapeHtml` and document the `headContent` raw-HTML contract.

  - **New export `escapeHtml(value)`** (from the package root) — escapes the five HTML-sensitive
    characters (`& < > " '` → `&amp; &lt; &gt; &quot; &[#39](https://github.com/aoede3/taujs/issues/39);`), so it is safe for both element text AND
    attribute values (single- and double-quoted). Non-string input is coerced via `String(value)`.
    Ships the helper the head-management guide previously told users to hand-roll (and whose hand-rolled
    version missed `'`).
  - **`headContent` contract JSDoc** on the `createRenderer` option and `HeadContext`: the return value
    is written into `<head>` as RAW HTML and is intentionally NOT auto-escaped, so any value
    interpolated from services/user input must be escaped with `escapeHtml`.

  No render-path behaviour change. `minor` for the additive export.

### Patch Changes

- [#15](https://github.com/aoede3/taujs/pull/15) [`da705dc`](https://github.com/aoede3/taujs/commit/da705dc9b6b16e1f1142fc9004bb34d8e9de7df9) Thanks [@aoede3](https://github.com/aoede3)! - R0-01: make `renderStream().done` crash-safe by default. `createStreamController` now
  pre-attaches a no-op rejection handler to its settled promise, so an unobserved `done` can
  never raise `unhandledRejection` - which Node's default mode escalates to a
  process-terminating `uncaughtException` - when a stream aborts fatally. Consumers who
  `await done` still receive the fatal error. A child-process regression test (run under
  Node's default rejection mode) proves the process no longer exits on an unobserved rejection.

- [#15](https://github.com/aoede3/taujs/pull/15) [`2796218`](https://github.com/aoede3/taujs/commit/27962189f05be03569a2b8f3d9c02daa97f798b9) Thanks [@aoede3](https://github.com/aoede3)! - R0-02: classify benign stream errors by ORIGIN, not by message substring. `isBenignStreamErr`
  now takes a `source: 'socket' | 'render'`. Only socket/writable-origin errors — by `err.code`
  (`ECONNRESET`, `EPIPE`, `ERR_STREAM_PREMATURE_CLOSE`, `ERR_STREAM_DESTROYED`), an `AbortError`
  name, or an exact node/undici socket message — are treated as benign client disconnects;
  render-origin errors are never benign by shape. An application error whose message merely
  contains "aborted"/"premature" (or carries a spoofed `code`) is no longer swallowed as a
  disconnect. The `DEFAULT_BENIGN_ERRORS` regex and `wireWritableGuards`' `benignErrorPattern`
  option are retired.

  Interim behaviour: a render-origin disconnect-lookalike now routes to the error path (fatal
  until the R1-01 streaming rework makes post-shell errors log-only) instead of being silently
  dropped — an observable error beats silent data loss.

- [#15](https://github.com/aoede3/taujs/pull/15) [`27ccf74`](https://github.com/aoede3/taujs/commit/27ccf741ebb71b8a0e8492c2264049ad1df4aecd) Thanks [@aoede3](https://github.com/aoede3)! - R0-03: `enableDebug` now gates only log VERBOSITY, not error visibility. In `createUILogger`,
  `warn` and `error` always route — to the provided logger if any, else `console.warn`/
  `console.error`; only `log` is silenced when `enableDebug` is false.

  **Behaviour change:** production consumers that did not enable debug will now see renderer
  warnings and errors (data-promise rejections, stream/`onHead`/`onShellReady` callback errors,
  missing root element, recoverable hydration errors) on their logger/console. This is the intended
  observability fix (RFC S2), not a regression. Call sites explicitly wrapped in `if (enableDebug)`
  (e.g. the CSR-fallback "no initial data" notice) remain debug-only. Note: `benignAbort`'s warning
  on a client disconnect is now visible too and may be frequent under load — filter by level if
  undesired.

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

- [#15](https://github.com/aoede3/taujs/pull/15) [`243056d`](https://github.com/aoede3/taujs/commit/243056d7d9bb2a0d23e92ed9596ead1011aafa98) Thanks [@aoede3](https://github.com/aoede3)! - R0 recheck-2 fix: React's `renderToPipeableStream` `onError` no longer coerces the error before
  reaching the crash-safe `failFatal` helper. It previously did `String((err)?.message ?? '')` at
  the top of the callback, so a hostile framework error (an object with a throwing `message` getter,
  or a `message` whose `Symbol.toPrimitive` throws) threw at that line BEFORE `failFatal` — skipping
  `controller.fatalAbort` (no cleanup, `done` never settled) and escaping React's asynchronous
  renderer callback as an uncaught exception. The raw error is now passed to the non-throwing UI
  logger and routed straight to `failFatal`, so settlement/cleanup always run with the original error.

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

- [#15](https://github.com/aoede3/taujs/pull/15) [`dc39b32`](https://github.com/aoede3/taujs/commit/dc39b327733df45999a2c685fced48161b748078) Thanks [@aoede3](https://github.com/aoede3)! - R1-01: rework `renderStream` so late-resolving route data can no longer be lost or hang the
  response, and so render errors are classified honestly.

  - **Bounded end-gate.** React pipes into a delegating sink that forwards every write to the real
    writable (React still drives backpressure against it) but DEFERS `end()` until the store's route
    data has settled, raced against a new `dataTimeoutMs` option (default 30000ms). A never-settling
    loader now fails the response deterministically instead of holding it — and its sockets/listeners —
    open. Final data is delivered exactly once from the gate, replacing the previous thrown-thenable
    retry dance. Fixes the silent data-loss class where the stream could finish serializing `{}` before
    late data arrived.
  - **`onRenderError` (new, advisory, non-fatal).** React's `onError` fires for EVERY render error,
    including post-shell boundary errors it recovers client-side. Treating that as fatal over-aborted
    otherwise-recoverable responses. `onError` no longer fails the response; render errors are surfaced
    through a new `onRenderError({ error, phase, recoverable })` callback (`phase` is observed timing,
    never a fatality signal). Fatality stays with `onShellError` / shell-timeout / writable guards.
  - **`onHead` is now fatal.** It commits the response head and connects the sink; a throwing `onHead`
    can no longer leave a half-committed response streaming into an unconsumed head.
  - **Internal store readiness.** `createSSRStore` attaches its settle promise under a package-internal
    symbol (not part of the public `SSRStore<T>` type) so the gate can await readiness without a public
    `ready` surface. The Suspense throw mechanism is unchanged.
  - **Abort-safe end-gate.** A client disconnect (or manual `abort()`) DURING the data wait now clears
    the armed data-timer promptly, suppresses delivery, and never `end()`s a torn-down writable — so it
    cannot leak the timer/closure or fire a spurious/duplicate fatal `onError` after settlement. A
    loader that resolves to `undefined` becomes a clean fatal instead of a hung response.
  - **Liveness is bounded even when a `<Suspense>` consumer suspends forever.** The route-data deadline
    is now armed at shell commit, INDEPENDENT of React calling the sink's `end()`. A `useSSRStore()`
    consumer suspending on never-settling data keeps React's stream open (so React never ends), but the
    response is still bounded by `dataTimeoutMs` and torn down deterministically.
  - **A fatal always rejects `done`, even if the host `onError` re-entrantly aborts.** `failFatal` now
    claims the terminal fatal state before invoking the (isolated) host callback. Previously, a host
    `onError` that synchronously aborted the passed `AbortSignal` (as the server does) let the
    re-entrant benign-cancel win the one-shot controller and RESOLVE `done`, silently downgrading a
    fatal — contradicting the `RenderStreamHandle` contract.

  - **Data deadline teardown is controller-owned, not `'close'`-dependent.** The route-data deadline is
    disarmed by controller cleanup on any termination (its idempotent `disarm` is composed into the
    cleanup), with the writable's `'close'` as a secondary signal — a writable created with
    `emitClose: false` is destroyed without emitting `'close'`, so relying on that event would retain the
    timer/listener until `dataTimeoutMs`.

  New public surface: `onRenderError` callback, `RenderErrorInfo` type, and the `dataTimeoutMs` stream
  option. `Writable` is kept a type-only import so this server-only renderer never pulls `node:stream`
  into a client bundle (mirrors `@taujs/vue`). Verified against real `react-dom/server` by an 18-test
  integration suite (post/pre-shell error timing, bounded gate, store-error, onHead, backpressure,
  abort-during-data-wait, undefined-data, suspend-forever liveness, re-entrant-abort, emitClose:false
  deadline teardown, Suspense intact).

- [#15](https://github.com/aoede3/taujs/pull/15) [`d50527c`](https://github.com/aoede3/taujs/commit/d50527c51b1120de5c6a7591f2342b3c5cb1de10) Thanks [@aoede3](https://github.com/aoede3)! - Fix: the internal hydration commit reporter now WRAPS the app instead of sitting beside it.

  React's `useId` is tree-position sensitive: a SIBLING of the app shifts every `useId` value in the app,
  so the sibling reporter introduced with the hydration-observability work made the client tree's ids
  diverge from the SSR markup (which renders the app without it) - a hydration mismatch for any app using
  `useId`. The reporter is now a pass-through wrapper: it adds tree DEPTH only (which `useId` ignores) and
  no extra DOM, so a `useId` app hydrates with no mismatch. First-commit detection (onSuccess /
  hydration:success) is unchanged.

- [#15](https://github.com/aoede3/taujs/pull/15) [`48574c1`](https://github.com/aoede3/taujs/commit/48574c1b99b731c4fcadf832636eff15e49dc8c1) Thanks [@aoede3](https://github.com/aoede3)! - R2-01: make client-side render failures observable and the success signal honest.

  - **One root-error adapter, wired to BOTH roots.** A single adapter object is passed to `hydrateRoot`
    AND `createRoot`: `onUncaughtError` (a render error with no boundary — the real, ASYNC client-error
    channel that a sync try/catch around `hydrateRoot`/`createRoot` cannot see) routes to a single
    failure path; `onCaughtError` (boundary-handled) and `onRecoverableError` (auto-recovered mismatch)
    are logged only, never treated as bootstrap failures. Previously the hydrate path had only a
    sync-only try/catch (which never fired for real async render errors) and the CSR path had NO error
    routing at all.
  - **Provable success.** `onSuccess` / `hydration:success` now fire on the FIRST ROOT COMMIT (an
    internal reporter effect), not synchronously when `hydrateRoot` returns (React root work is async,
    so the old signal was false). Documented semantics: "first root commit — does NOT claim every
    `<Suspense>` boundary hydrated". This fires slightly LATER than before (at commit).
  - **CSR path now reports.** A CSR-fallback mount now emits `onSuccess` on commit and `onHydrationError`
    on an uncaught render error — but NO beacon events (a CSR mount is not a hydration; vue parity).
  - **Single settlement.** Exactly one of `onSuccess` | `onHydrationError` fires per `hydrateApp` call
    (first commit vs first uncaught error wins); later signals are telemetry, logged only.
  - **Missing root** now routes to `onHydrationError` + a `hydration:error` beacon (error-without-start,
    vue precedent) instead of logging and returning silently.
  - **Global error surfacing preserved.** Overriding `onUncaughtError` replaces React's default, which
    re-surfaces uncaught errors globally. `onUncaughtError` now mirrors React's `reportGlobalError`:
    prefer `globalThis.reportError`, else dispatch a cancelable `window` `ErrorEvent` — so
    `window.onerror`-based monitoring (Sentry/Bugsnag globalHandlers) keeps seeing uncaught render
    errors — including after hydration has settled, and on runtimes/older browsers without
    `reportError` — on top of the taujs bootstrap routing.
  - **Lifecycle callbacks are isolated observers.** `onStart` / `onSuccess` / `onHydrationError` throws
    are logged and swallowed. This is load-bearing: `onSuccess` runs inside the reporter's React effect
    and `onHydrationError` inside the root `onUncaughtError` handler, so an un-isolated throw would enter
    React's root-error domain (a throwing `onSuccess` could tear the committed root down while success
    had already "won" settlement). An observability hook can no longer destroy the root it observes.

  Beacon event names are unchanged (`hydration:start|success|error`); `emitDevHook` stays
  dev-only/no-throw. `HydrateAppOptions` is fully JSDoc'd. Verified against real `react-dom/client` in
  jsdom (async error timing, first-commit success, StrictMode single-fire, mismatch recoverability).

- [#15](https://github.com/aoede3/taujs/pull/15) [`6376532`](https://github.com/aoede3/taujs/commit/63765320666d7252cc1e2a7b744878ee43226b4a) Thanks [@aoede3](https://github.com/aoede3)! - R2-04: plumb React's `identifierPrefix` through the renderer and hydrator so multi-root pages get
  stable, collision-free `useId` values.

  - `createRenderer({ identifierPrefix })` is passed to `renderToString` (SSR) and
    `renderToPipeableStream` (streaming).
  - `hydrateApp({ identifierPrefix })` is passed to BOTH `hydrateRoot` and the CSR-fallback `createRoot`.

  It must be identical on the server and client for a given root (React requires this, or `useId`
  hydration mismatches). Set it when rendering more than one taujs root on a page (the app-per-boundary
  / micro-frontend model) so each root's ids are disjoint. Additive option, no behaviour change when
  unset. Both surfaces are JSDoc'd; a server-derived default from `appId` is left as an R3-03 note.

- [#15](https://github.com/aoede3/taujs/pull/15) [`4dda857`](https://github.com/aoede3/taujs/commit/4dda857432473f2b8ccefe72c9e5e43e8b4c2d2b) Thanks [@aoede3](https://github.com/aoede3)! - R3-01: contract conformance test, and fix a peer contract that broke `npm install` for scaffolded apps.

  - **Fixes a broken install.** The `@vitejs/plugin-react` peer was `^5.1.2` while `create-taujs`
    scaffolds `^4.6.0`, so a freshly generated React app hard-failed `npm install` with ERESOLVE. The
    range is now `^4.6.0 || ^5.0.0`. NB `peerDependenciesMeta.optional` permits a peer to be ABSENT; it
    does NOT relax its version range when the peer is present, so marking tooling optional did not fix
    this on its own.
  - **Peer contract corrected.** Runtime peers `react` / `react-dom` are now REQUIRED (they were marked
    optional, yet the root entry imports them) with an honest `^19.0.0` floor - the previous `^19.2.3`
    was a devDependency mirror that needlessly blocked the whole React 19.0.x and 19.1.x lines. Tooling
    peers (`vite`, `typescript`, `@vitejs/plugin-react`) are now OPTIONAL, with `vite` lowered to `^7.0.0`
    (the old `^7.3.1` floor rejected vite 7.2.x even though the tooling is optional).
  - **Types the published `.d.ts` needs are now declared** as optional peers: `@types/react`,
    `@types/react-dom` (the `react` package ships no types, and `dist/index.d.ts` imports from it) and
    `@types/node` (the root types reference `node:stream`). Previously undeclared, so a TypeScript
    consumer could silently degrade `React` to `any` under `skipLibCheck`.
  - **Contract conformance test** (`src/test/contract.test-d.ts`, tsc-enforced via `typecheck`, outside
    the vitest glob): proves `createRenderer(...)` satisfies `@taujs/server`'s `RenderModule` with ZERO
    casts, and pins the `renderStream` RETURN shape against `RenderStreamHandle` in both directions -
    function assignability alone can hide a capability gap through width-subtyping. Verified to bite:
    narrowing a param, dropping `done` from the renderer's return, and weakening the contract itself
    (making `done` optional) each fail `typecheck`; the last is caught ONLY by the return-shape
    assertions, which the plain module assertion tolerates.
  - `"sideEffects": false` and a real `description` (was a placeholder).

  No runtime source change.

- [#15](https://github.com/aoede3/taujs/pull/15) [`54d373e`](https://github.com/aoede3/taujs/commit/54d373e7b9d4160af2bcb56d693a497aec8ecf6f) Thanks [@aoede3](https://github.com/aoede3)! - R3-02: three contained hygiene fixes in the store and utils.

  - **Error normalisation.** A rejected data load that threw a STRING produced a quoted message
    (`'"boom"'`), and one that threw a CIRCULAR object made `JSON.stringify` THROW inside the store's
    error handler - turning a data-load failure into an unhandled rejection. The store now normalises via
    the same pattern as `@taujs/vue`: an `Error` passes through unchanged, a string keeps its message
    unquoted, an object is JSON-stringified, and an unserialisable value falls back to `String(error)`
    without throwing.
  - **`useSSRStore` reads the store directly.** Removed `useMemo(() => deferred, [deferred])` (an identity
    memo - a no-op by definition) and `useDeferredValue`, which was introduced with no stated rationale, is
    relied on by no test, has no `@taujs/vue` equivalent, and measurably cost an extra render pass per
    update while serving one-render-stale data. Consumers now observe `setData` immediately. The Suspense
    path is unaffected (suspension happens inside `useSyncExternalStore`, before any value reaches the
    removed hooks).
  - Deleted the dead `utils/index.ts` barrel (`export * from './'` - self-referential, exported nothing,
    imported by nothing).

- [#15](https://github.com/aoede3/taujs/pull/15) [`b1fedd4`](https://github.com/aoede3/taujs/commit/b1fedd43fc48d9810e2ec7f009fd1dd0270bb4d7) Thanks [@aoede3](https://github.com/aoede3)! - R3-05 (Q6): client bundles no longer include `react-dom/server`. The dist previously shipped as a
  single module whose top-level imports coupled the SSR renderer into the client entry, so every
  production browser bundle of `import { hydrateApp } from '@taujs/react'` retained react-dom's CJS
  browser server build (measured: -49% raw / -48% gzip after the fix, with `react-dom/server`
  provably absent from the module graph). The dist now preserves the source module graph (explicit
  `.js` specifiers + unbundled build); the public API, exports map, and `create-taujs` scaffold are
  unchanged - no consumer migration needed. Durable guards added: a module-graph absence test that
  builds a real production browser bundle, and a specifier-extension lint test. Also documents the
  official `useSyncExternalStore` suspension caveat on `useSSRStore` (R3-03 §0).

- [#15](https://github.com/aoede3/taujs/pull/15) [`b3305c5`](https://github.com/aoede3/taujs/commit/b3305c50815e54e6fa5995cca228c8a99432cabb) Thanks [@aoede3](https://github.com/aoede3)! - R3-06 (Q3, Policy A): the `ssr` strategy now renders COMPLETE HTML via `prerenderToNodeStream`
  instead of `renderToString`. Previously any `React.lazy`/`use()` subtree was SILENTLY replaced by
  its Suspense fallback plus a client-render marker, with zero diagnostics - the page lost its SSR
  content. Behaviour change to note: a route that was accidentally fast because it silently dropped
  its lazy content now correctly waits for it, bounded by the new `ssrOptions.prerenderTimeoutMs`
  (default 10s; `0` = wait forever). On deadline expiry a page whose shell completed is served with
  its unfinished boundaries in the fallback state (the client completes them after hydration; an
  advisory warning is logged) and a page whose shell never completed fails the request instead of
  serving a blank page. Output for non-suspending trees is byte-identical to `renderToString`
  (pinned by test), route data is unaffected (the server resolves it before rendering), and the
  `RenderSSR` server contract is untouched. Requires no consumer migration.

  Gate-review hardening: `ssrOptions.prerenderTimeoutMs` is validated at `createRenderer` (a
  positive finite number, `0`, or `Infinity`; anything else throws a `TypeError` instead of
  silently waiting forever), and the prerender API is imported from the CONDITIONAL
  `react-dom/static` subpath so browser bundlers resolve a browser-safe build - the earlier
  Node-only subpath produced browser-compatibility warnings (and could hard-fail stricter
  bundlers) even though final bundle bytes were clean.

- [#15](https://github.com/aoede3/taujs/pull/15) [`cfbcfae`](https://github.com/aoede3/taujs/commit/cfbcfae85bb44991989704d2711982cf24bf6024) Thanks [@aoede3](https://github.com/aoede3)! - R3-08 (S2): an explicit `setData` now supersedes the store's in-flight initial promise. Previously
  a LATE loader rejection flipped the store to `'error'`, made `getSnapshot` throw, and tore down a
  tree already committed with the explicitly-set data (uncaught render error, DOM wiped); a late
  loader resolution silently overwrote the explicit value. Both settlements are now ignored once
  `setData` has run. Unreachable via taujs's own paths (`hydrateApp` builds the store from resolved
  data) - this hardens the public `createSSRStore`. The internal readiness promise still settles
  when the loader does, so the streaming end-gate is unaffected (pinned by test).

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
