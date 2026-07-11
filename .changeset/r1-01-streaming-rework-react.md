---
'@taujs/react': patch
---

R1-01: rework `renderStream` so late-resolving route data can no longer be lost or hang the
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

New public surface: `onRenderError` callback, `RenderErrorInfo` type, and the `dataTimeoutMs` stream
option. `Writable` is kept a type-only import so this server-only renderer never pulls `node:stream`
into a client bundle (mirrors `@taujs/vue`). Verified against real `react-dom/server` by a 17-test
integration suite (post/pre-shell error timing, bounded gate, store-error, onHead, backpressure,
abort-during-data-wait, undefined-data, suspend-forever liveness, re-entrant-abort, Suspense intact).
