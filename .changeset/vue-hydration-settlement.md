---
'@taujs/vue': patch
---

`hydrateApp` no longer reverses a settled hydration success

Vue emitted `hydration:success` / `onSuccess` immediately after `mount()` but kept its
error-attribution phase open until the next tick, so an error surfaced through
`app.config.errorHandler` in that window could still emit `hydration:error` and call
`onHydrationError` for an already-successful hydration. A single-settlement guard now marks the
attempt settled **before** emitting success, so any subsequent error in that window is log-only - it
never emits a second beacon or reverses the success. Exactly one of `onSuccess` | `onHydrationError`
settles per call.
