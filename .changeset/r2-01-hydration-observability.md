---
'@taujs/react': patch
---

R2-01: make client-side render failures observable and the success signal honest.

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
  re-surfaces uncaught errors globally (`reportError` → a `window` `'error'` event). `onUncaughtError`
  now calls `reportError` so `window.onerror`-based monitoring (Sentry/Bugsnag globalHandlers) keeps
  seeing uncaught render errors — including after hydration has settled — on top of the taujs bootstrap
  routing.
- **Lifecycle callbacks are isolated observers.** `onStart` / `onSuccess` / `onHydrationError` throws
  are logged and swallowed. This is load-bearing: `onSuccess` runs inside the reporter's React effect
  and `onHydrationError` inside the root `onUncaughtError` handler, so an un-isolated throw would enter
  React's root-error domain (a throwing `onSuccess` could tear the committed root down while success
  had already "won" settlement). An observability hook can no longer destroy the root it observes.

Beacon event names are unchanged (`hydration:start|success|error`); `emitDevHook` stays
dev-only/no-throw. `HydrateAppOptions` is fully JSDoc'd. Verified against real `react-dom/client` in
jsdom (async error timing, first-commit success, StrictMode single-fire, mismatch recoverability).
