---
'@taujs/server': patch
---

P0B-04: dev boots stamp `window.__TAUJS_TRACE_ID__` + the per-boot token and inject the beacon script (nonce-aware) into rendered pages — alongside `__INITIAL_DATA__` on SSR, in the head write on streaming, and into the fallthrough shell, which has no data script to ride with. The script listens to `hydrateApp`'s internal events and POSTs `{ traceId, ok, ms?, error? }` to `/__taujs/beacon` once, with the token header. Present only when the structural dev gate holds; production HTML never carries any of it.
