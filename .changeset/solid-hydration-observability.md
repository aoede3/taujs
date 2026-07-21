---
'@taujs/solid': minor
---

Add client hydration observability options to `hydrateApp`

`hydrateApp` now accepts `logger`, `enableDebug`, `onStart` and `onSuccess` alongside the existing
`onHydrationError`, bringing `@taujs/solid` to the same client-hydration lifecycle contract as
`@taujs/react` and `@taujs/vue`:

- `onStart` observes the start of hydration (hydrate path only); `onSuccess` observes successful
  root establishment on both the hydrate and CSR-fallback paths; `onHydrationError` observes a
  failed root establishment. Exactly one of `onSuccess` | `onHydrationError` settles per call, each
  at most once, and every observer is isolated - a callback throw is logged and never alters
  settlement or tears down the root.
- `logger` receives the lifecycle; `enableDebug` gates verbose start/success logs (warnings and
  errors are never gated). With no logger supplied, warnings and errors fall back to the browser
  console. The route-data snapshot is never logged.
- The internal `hydration:*` beacons remain hydration-only and always precede the matching user
  callback.

`dataKey` is deliberately not added - `window.__INITIAL_DATA__` is the single snapshot authority.
React-specific (`identifierPrefix`) and Vue-specific (`setupApp`) options are not inherited by
analogy either; `renderId` remains Solid's framework-native identity option.
