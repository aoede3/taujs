---
'@taujs/mcp': minor
---

`@taujs/mcp` reads the observations schema-version-2 additions from `@taujs/server` (RFC 0018). `taujs_who_calls_service` gains a `hostObserved` list: a Fastify route the application registered itself, seen calling the registry in development traffic, reported separately from `declared` and `observed` so it is never mistaken for a declared edge. `taujs_explain_route` can now answer for such a path from episodes rather than refusing outright, and its wording for a path with no episodes says "no observation", never that no request occurred.

Reading `episodes.ndjson` is now gated as a paired read with `observations.json`'s schema version: both refuse together on a mismatch, fail closed, rather than reading episode records individually.
