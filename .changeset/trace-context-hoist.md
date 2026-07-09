---
'@taujs/server': minor
---

P0B-01: trace context is now created in a shared `onRequest` hook (registered deliberately before the auth hook), so every request — rendered, fallthrough, or asset-like — has a `traceId` before route matching. Behaviour addition: fallthrough (client-rendered) responses now carry the `x-trace-id` response header, and fallthrough logs carry the request's trace context. Rendered-route behaviour is observably unchanged; `handleRender`/`handleNotFound` invoked without the hook (direct composition) behave exactly as before.
