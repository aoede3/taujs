---
'@taujs/vue': patch
---

Gate R2 review: fix four Vue lifecycle defects that the React hardening work had already fixed but
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
